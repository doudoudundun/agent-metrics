type IconName =
  | "brand"
  | "grid"
  | "trend"
  | "layers"
  | "sync"
  | "focus"
  | "refresh"
  | "pin"
  | "open"
  | "close";

type UiIconProps = {
  name: IconName;
  size?: number;
  className?: string;
};

export function UiIcon({ name, size = 18, className }: UiIconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
    >
      {paths[name]}
    </svg>
  );
}

const paths = {
  brand: <><path d="M5 18 12 4l7 14" /><path d="M8 12h8M9.5 18h5" /></>,
  grid: <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></>,
  trend: <><path d="M4 18V6M4 18h16" /><path d="m7 14 4-4 3 2 5-6" /><path d="M16 6h3v3" /></>,
  layers: <><path d="m12 4 8 4-8 4-8-4 8-4Z" /><path d="m4 12 8 4 8-4M4 16l8 4 8-4" /></>,
  sync: <><path d="M20 7v5h-5" /><path d="M4 17v-5h5" /><path d="M6.1 8a7 7 0 0 1 11.8-1L20 12M4 12l2.1 5a7 7 0 0 0 11.8-1" /></>,
  focus: <><path d="M8 4H4v4M16 4h4v4M20 16v4h-4M8 20H4v-4" /><circle cx="12" cy="12" r="3" /></>,
  refresh: <><path d="M20 7v5h-5" /><path d="M18.5 16a8 8 0 1 1 1.3-8.8L20 12" /></>,
  pin: <><path d="m9 4 6 0 1 6 3 3-4 1-3 6-3-6-4-1 3-3 1-6Z" /></>,
  open: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" /></>,
  close: <><path d="M6 6l12 12M18 6 6 18" /></>
} satisfies Record<IconName, React.ReactNode>;
