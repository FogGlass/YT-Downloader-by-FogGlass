//! Self-extracting payload reader.
//!
//! The finished installer is a single `.exe`: the compiled stub, then the payload
//! block, then a 24-byte footer. Keeping the archive appended (instead of embedding it
//! through `include_bytes!`) means the stub stays small, the payload can be produced by
//! the build script, and extraction can stream from disk without ever holding the
//! whole archive in memory.
//!
//! ```text
//! [ installer stub ][ payload block ][ footer ]         footer magic "YTDSETUP"
//!
//! payload block:
//!   "YTDPAYLOAD1" | u32 entry count | entry headers … | data blocks …
//!   entry header: u16 name len | name | u64 original | u64 compressed | u8 method
//! ```

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::SetupError;

pub const FOOTER_MAGIC: &[u8; 8] = b"YTDSETUP";
pub const FOOTER_LEN: u64 = 24;
/// "YTDPAYLOAD1" — 11 bytes.
pub const BLOCK_MAGIC: &[u8; 11] = b"YTDPAYLOAD1";

/// Copy granularity. Small enough to keep the progress bar honest and cancellation
/// responsive, large enough to stay cheap.
const CHUNK: usize = 128 * 1024;

#[derive(Debug, Clone)]
pub struct PayloadEntry {
    pub name: String,
    pub original_size: u64,
    pub compressed_size: u64,
    /// 0 = stored, 1 = raw deflate.
    pub method: u8,
    pub data_offset: u64,
}

#[derive(Debug)]
pub struct Payload {
    file: File,
    entries: Vec<PayloadEntry>,
    /// Offset at which the payload block starts — i.e. the length of the pure
    /// installer stub with no payload attached.
    stub_len: u64,
    /// Total size after extraction — what the target disk must be able to hold.
    pub extracted_bytes: u64,
    /// Total size inside the installer.
    pub compressed_bytes: u64,
}

impl Payload {
    /// Open the payload appended to the currently running executable.
    pub fn open_self() -> Result<Payload, SetupError> {
        let exe = std::env::current_exe()?;
        Payload::open(&exe)
    }

    pub fn open(path: &Path) -> Result<Payload, SetupError> {
        let mut file = File::open(path)?;
        let file_len = file.metadata()?.len();

        if file_len < FOOTER_LEN + 12 {
            return Err(SetupError::Payload(
                "安装包不完整：没有找到内置载荷。".into(),
            ));
        }

        // Footer
        file.seek(SeekFrom::Start(file_len - FOOTER_LEN))?;
        let mut footer = [0u8; FOOTER_LEN as usize];
        file.read_exact(&mut footer)?;
        if &footer[0..8] != FOOTER_MAGIC {
            return Err(SetupError::Payload(
                "安装包不完整：载荷标记缺失（是否被截断或重新签名过？）。".into(),
            ));
        }
        let payload_offset = u64::from_le_bytes(footer[8..16].try_into().unwrap());
        let payload_len = u64::from_le_bytes(footer[16..24].try_into().unwrap());
        if payload_offset + payload_len + FOOTER_LEN != file_len {
            return Err(SetupError::Payload(format!(
                "安装包大小与载荷记录不一致（{payload_offset}+{payload_len} != {file_len}）。"
            )));
        }

        // Block header
        file.seek(SeekFrom::Start(payload_offset))?;
        let mut magic = [0u8; 11];
        file.read_exact(&mut magic)?;
        if &magic != BLOCK_MAGIC {
            return Err(SetupError::Payload("载荷格式无法识别。".into()));
        }

        let entry_count = read_u32(&mut file)? as usize;
        let mut entries = Vec::with_capacity(entry_count);
        let mut extracted_bytes = 0u64;

        for _ in 0..entry_count {
            let name_len = read_u16(&mut file)? as usize;
            if name_len == 0 || name_len > 4096 {
                return Err(SetupError::Payload("载荷目录损坏。".into()));
            }
            let mut name_bytes = vec![0u8; name_len];
            file.read_exact(&mut name_bytes)?;
            let name = String::from_utf8(name_bytes)
                .map_err(|_| SetupError::Payload("载荷中存在非 UTF-8 路径。".into()))?;

            let original_size = read_u64(&mut file)?;
            let compressed_size = read_u64(&mut file)?;
            let mut method = [0u8; 1];
            file.read_exact(&mut method)?;

            extracted_bytes += original_size;
            entries.push(PayloadEntry {
                name,
                original_size,
                compressed_size,
                method: method[0],
                data_offset: 0,
            });
        }

        // Data blocks follow the header block in entry order.
        let mut offset = file.stream_position()?;
        for entry in &mut entries {
            entry.data_offset = offset;
            offset += entry.compressed_size;
        }

        if offset > payload_offset + payload_len {
            return Err(SetupError::Payload("载荷目录越界。".into()));
        }

        Ok(Payload {
            file,
            entries,
            stub_len: payload_offset,
            extracted_bytes,
            compressed_bytes: payload_len,
        })
    }

    /// Length of the executable without its appended payload.
    pub fn stub_len(&self) -> u64 {
        self.stub_len
    }

    pub fn entries(&self) -> &[PayloadEntry] {
        &self.entries
    }

    pub fn file_count(&self) -> usize {
        self.entries.len()
    }

    /// Stream every entry into `target`.
    ///
    /// `on_progress` receives (bytes written so far, current file name). Cancellation is
    /// checked between chunks so a cancelled install stops within milliseconds.
    pub fn extract(
        &self,
        target: &Path,
        cancel: &AtomicBool,
        on_progress: &mut dyn FnMut(u64, &str),
    ) -> Result<u64, SetupError> {
        std::fs::create_dir_all(target)?;
        let mut written_total = 0u64;

        for entry in &self.entries {
            if cancel.load(Ordering::SeqCst) {
                return Err(SetupError::Cancelled);
            }

            let destination = safe_join(target, &entry.name)?;
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent)?;
            }

            // Seek FIRST, then wrap in `take`. Doing it the other way round makes
            // `Take::seek` compute a negative remaining limit and fail with an opaque
            // "invalid input parameter" error on Windows.
            let mut reader = &self.file;
            reader.seek(SeekFrom::Start(entry.data_offset))?;
            let mut source = reader.take(entry.compressed_size);

            let mut output = File::create(&destination)?;
            let copied = match entry.method {
                1 => {
                    let mut decoder = flate2::read::DeflateDecoder::new(source);
                    copy_stream(&mut decoder, &mut output, cancel, on_progress, &mut written_total, &entry.name)?
                }
                _ => copy_stream(&mut source, &mut output, cancel, on_progress, &mut written_total, &entry.name)?,
            };

            if copied != entry.original_size {
                return Err(SetupError::Payload(format!(
                    "{} 解压后大小不符（期望 {}，实际 {}）。",
                    entry.name, entry.original_size, copied
                )));
            }
            output.flush()?;
        }

        Ok(written_total)
    }
}

fn copy_stream(
    source: &mut impl Read,
    output: &mut impl Write,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(u64, &str),
    written_total: &mut u64,
    name: &str,
) -> Result<u64, SetupError> {
    let mut buffer = vec![0u8; CHUNK];
    let mut written = 0u64;

    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(SetupError::Cancelled);
        }
        let read = match source.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(SetupError::Io(error)),
        };
        output.write_all(&buffer[..read])?;
        written += read as u64;
        *written_total += read as u64;
        on_progress(*written_total, name);
    }

    Ok(written)
}

/// Join an archive path onto the target directory, refusing anything that would
/// escape it. A crafted payload must never be able to write outside the install
/// directory.
pub fn safe_join(target: &Path, relative: &str) -> Result<PathBuf, SetupError> {
    let normalised = relative.replace('\\', "/");
    let candidate = Path::new(&normalised);

    if candidate.is_absolute() {
        return Err(SetupError::Payload(format!("载荷包含绝对路径：{relative}")));
    }

    let mut result = target.to_path_buf();
    for component in candidate.components() {
        match component {
            Component::Normal(part) => result.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(SetupError::Payload(format!("载荷包含非法路径：{relative}")));
            }
        }
    }

    if !result.starts_with(target) {
        return Err(SetupError::Payload(format!("载荷路径越界：{relative}")));
    }
    Ok(result)
}

fn read_u16(reader: &mut impl Read) -> io::Result<u16> {
    let mut buffer = [0u8; 2];
    reader.read_exact(&mut buffer)?;
    Ok(u16::from_le_bytes(buffer))
}

fn read_u32(reader: &mut impl Read) -> io::Result<u32> {
    let mut buffer = [0u8; 4];
    reader.read_exact(&mut buffer)?;
    Ok(u32::from_le_bytes(buffer))
}

fn read_u64(reader: &mut impl Read) -> io::Result<u64> {
    let mut buffer = [0u8; 8];
    reader.read_exact(&mut buffer)?;
    Ok(u64::from_le_bytes(buffer))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn paths_cannot_escape_the_target() {
        let target = Path::new(r"E:\YT Downloader");
        assert!(safe_join(target, "runtime/FFMPEG-9.0/bin/ffmpeg.exe").is_ok());
        assert!(safe_join(target, "data/config/settings.json").is_ok());
        assert!(safe_join(target, "../evil.exe").is_err());
        assert!(safe_join(target, "runtime/../../evil.exe").is_err());
        assert!(safe_join(target, r"C:\Windows\system32\evil.dll").is_err());
        assert!(safe_join(target, "/etc/passwd").is_err());
    }

    #[test]
    fn a_truncated_file_is_rejected_with_a_clear_error() {
        let dir = std::env::temp_dir().join("ytd-setup-payload-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("fake.exe");
        std::fs::write(&file, vec![0u8; 64]).unwrap();

        let error = Payload::open(&file).unwrap_err();
        assert!(error.to_string().contains("安装包不完整"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_bad_footer_magic_is_rejected() {
        let dir = std::env::temp_dir().join("ytd-setup-payload-badmagic");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("fake.exe");
        let mut bytes = vec![0u8; 128];
        let len = bytes.len() as u64;
        bytes[(len - 24) as usize..(len - 16) as usize].copy_from_slice(b"NOTSETUP");
        std::fs::write(&file, &bytes).unwrap();

        assert!(Payload::open(&file).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cancellation_stops_extraction() {
        let cancel = AtomicBool::new(true);
        let mut sink = Vec::new();
        let mut source = io::Cursor::new(vec![7u8; 4096]);
        let mut total = 0u64;
        let result = copy_stream(
            &mut source,
            &mut sink,
            &cancel,
            &mut |_, _| {},
            &mut total,
            "x",
        );
        assert!(matches!(result, Err(SetupError::Cancelled)));
    }
}
