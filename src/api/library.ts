/** History and favourites. */

import { call } from "./client";
import type { FavoriteEntry, HistoryEntry } from "@/types/models";

export const historyList = (limit?: number) =>
  call<HistoryEntry[]>("history_list", { limit: limit ?? null });

export const historyRemove = (id: string) =>
  call<boolean>("history_remove", { id });

export const historyClear = (onlyFailed = false) =>
  call<number>("history_clear", { onlyFailed });

export const favoritesList = () => call<FavoriteEntry[]>("favorites_list");

export const favoritesUpsert = (entry: FavoriteEntry) =>
  call<FavoriteEntry[]>("favorites_upsert", { entry });

export const favoritesRemove = (id: string) =>
  call<FavoriteEntry[]>("favorites_remove", { id });

export const favoritesContains = (url: string) =>
  call<boolean>("favorites_contains", { url });
