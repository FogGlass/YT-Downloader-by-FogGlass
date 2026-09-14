/** Form controls: fields, text inputs, switches, sliders, selects and segments. */

import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import * as SelectPrimitive from "@radix-ui/react-select";
import * as SliderPrimitive from "@radix-ui/react-slider";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { motion } from "framer-motion";
import { Check, ChevronDown } from "lucide-react";
import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";

import { cn } from "@/lib/cn";
import { spring, transition } from "@/lib/motion";

/* -------------------------------------------------------------------------- */
/* Field                                                                      */
/* -------------------------------------------------------------------------- */

export interface FieldProps {
  label: string;
  description?: string;
  hint?: string;
  error?: string | null;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
  /** Stack the control under the label (default) or beside it. */
  orientation?: "vertical" | "horizontal";
}

export function Field({
  label,
  description,
  hint,
  error,
  htmlFor,
  children,
  className,
  orientation = "vertical",
}: FieldProps) {
  const message = error ?? hint;
  return (
    <div
      className={cn(
        orientation === "horizontal"
          ? "flex items-start justify-between gap-6"
          : "flex flex-col gap-1.5",
        className,
      )}
    >
      <div className={cn("min-w-0", orientation === "horizontal" && "flex-1")}>
        <label
          htmlFor={htmlFor}
          className="block text-label font-medium text-content"
        >
          {label}
        </label>
        {description ? (
          <p className="mt-0.5 text-caption leading-[1.1rem] text-content-tertiary">
            {description}
          </p>
        ) : null}
      </div>
      <div className={cn(orientation === "horizontal" && "shrink-0")}>{children}</div>
      {message ? (
        <p
          className={cn(
            "text-caption",
            error ? "text-danger" : "text-content-tertiary",
            orientation === "horizontal" && "mt-1 text-right",
          )}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Text inputs                                                                */
/* -------------------------------------------------------------------------- */

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  icon?: ReactNode;
  trailing?: ReactNode;
  invalid?: boolean;
  inputSize?: "sm" | "md";
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(
  function TextInput(
    { icon, trailing, invalid, inputSize = "md", className, ...rest },
    ref,
  ) {
    return (
      <div className={cn("relative flex items-center", className)}>
        {icon ? (
          <span className="pointer-events-none absolute left-3 text-content-tertiary">
            {icon}
          </span>
        ) : null}
        <input
          ref={ref}
          aria-invalid={invalid || undefined}
          className={cn(
            "field-input",
            inputSize === "sm" ? "h-8 text-label" : "h-9.5 text-body",
            icon ? "pl-9" : "pl-3",
            trailing ? "pr-9" : "pr-3",
          )}
          {...rest}
        />
        {trailing ? (
          <span className="absolute right-2 flex items-center">{trailing}</span>
        ) : null}
      </div>
    );
  },
);

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function TextArea({ className, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn("field-input resize-y px-3 py-2.5 text-body leading-[1.4rem]", className)}
        {...rest}
      />
    );
  },
);

/* -------------------------------------------------------------------------- */
/* Switch and checkbox                                                        */
/* -------------------------------------------------------------------------- */

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  label,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <SwitchPrimitive.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      className={cn(
        "relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full border border-transparent transition-colors",
        checked ? "bg-accent" : "bg-surface-active border-line",
        disabled && "opacity-40",
      )}
    >
      <SwitchPrimitive.Thumb asChild>
        <motion.span
          layout
          transition={spring}
          className={cn(
            "pointer-events-none block size-[17px] rounded-full bg-white shadow-sm",
            checked ? "ml-[19px]" : "ml-[2px]",
          )}
        />
      </SwitchPrimitive.Thumb>
    </SwitchPrimitive.Root>
  );
}

export function Checkbox({
  checked,
  onCheckedChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  description?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className={cn("flex items-start gap-2.5", disabled && "opacity-50")}>
      <CheckboxPrimitive.Root
        id={id}
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        disabled={disabled}
        className={cn(
          "mt-0.5 flex size-[17px] shrink-0 items-center justify-center rounded-[5px] border transition-colors",
          checked
            ? "border-accent bg-accent text-accent-contrast"
            : "border-line-strong bg-surface-muted hover:border-accent",
        )}
      >
        <CheckboxPrimitive.Indicator>
          <motion.span
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={transition.fast}
          >
            <Check className="size-3" strokeWidth={3} />
          </motion.span>
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      <label htmlFor={id} className="min-w-0 cursor-pointer text-label leading-[1.15rem]">
        <span className="text-content">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-caption text-content-tertiary">{description}</span>
        ) : null}
      </label>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Slider                                                                     */
/* -------------------------------------------------------------------------- */

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  label,
  format,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  label: string;
  format?: (value: number) => string;
}) {
  return (
    <div className="flex items-center gap-3">
      <SliderPrimitive.Root
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([next]) => onChange(next)}
        aria-label={label}
        className="relative flex h-5 w-40 touch-none items-center select-none"
      >
        <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-surface-active">
          <SliderPrimitive.Range className="absolute h-full bg-accent" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb className="block size-4 rounded-full border-2 border-accent bg-surface-elevated shadow-sm transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40" />
      </SliderPrimitive.Root>
      <span className="w-16 text-right text-label tabular-nums text-content-secondary">
        {format ? format(value) : value}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Select                                                                     */
/* -------------------------------------------------------------------------- */

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

export function Select({
  value,
  options,
  onChange,
  placeholder = "请选择",
  className,
  disabled,
  ariaLabel,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onChange} disabled={disabled}>
      <SelectPrimitive.Trigger
        aria-label={ariaLabel}
        className={cn(
          "field-input inline-flex h-8 items-center justify-between gap-2 px-2.5 text-label",
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon>
          <ChevronDown className="size-3.5 text-content-tertiary" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={6}
          className="floating z-50 max-h-72 min-w-[10rem] overflow-hidden rounded-[var(--radius-md)] p-1"
        >
          <SelectPrimitive.Viewport>
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                className="relative flex cursor-pointer select-none flex-col gap-0.5 rounded-[var(--radius-sm)] py-1.5 pr-8 pl-3 text-label outline-none data-[highlighted]:bg-surface-hover data-[state=checked]:text-accent"
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                {option.description ? (
                  <span className="text-caption text-content-tertiary">
                    {option.description}
                  </span>
                ) : null}
                <SelectPrimitive.ItemIndicator className="absolute top-1/2 right-2 -translate-y-1/2">
                  <Check className="size-3.5" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

/* -------------------------------------------------------------------------- */
/* Segmented control                                                          */
/* -------------------------------------------------------------------------- */

export interface Segment<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  badge?: string;
}

/**
 * A segmented control whose selection indicator is a single shared element, so it
 * slides between options instead of blinking from one to the next.
 */
export function SegmentedControl<T extends string>({
  value,
  segments,
  onChange,
  size = "md",
  layoutId,
  className,
}: {
  value: T;
  segments: Segment<T>[];
  onChange: (value: T) => void;
  size?: "sm" | "md";
  layoutId: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cn(
        "inline-flex items-center gap-1 rounded-[var(--radius-md)] border border-line bg-surface-muted p-1",
        className,
      )}
    >
      {segments.map((segment) => {
        const active = segment.value === value;
        return (
          <button
            key={segment.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(segment.value)}
            className={cn(
              "relative inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] font-medium transition-colors",
              size === "sm" ? "h-6.5 px-2.5 text-caption" : "h-7.5 px-3 text-label",
              active ? "text-content" : "text-content-tertiary hover:text-content-secondary",
            )}
          >
            {active ? (
              <motion.span
                layoutId={layoutId}
                transition={spring}
                className="absolute inset-0 rounded-[var(--radius-sm)] bg-surface-elevated shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
              />
            ) : null}
            <span className="relative z-10 inline-flex items-center gap-1.5">
              {segment.icon}
              {segment.label}
              {segment.badge ? (
                <span className="rounded-full bg-surface-active px-1.5 text-micro tabular-nums">
                  {segment.badge}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
