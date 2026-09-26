import type { ReactNode } from "react";

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {children}
    </svg>
  );
}

export function Icon({ children }: { children: ReactNode }) {
  return <span className="icon">{children}</span>;
}

export function BackIcon() {
  return (
    <Svg>
      <path d="M15 5 8 12l7 7" />
    </Svg>
  );
}

export function SearchIcon() {
  return (
    <Svg>
      <circle cx="11" cy="11" r="6" />
      <path d="m16 16 4 4" />
    </Svg>
  );
}

export function ChevronRightIcon() {
  return (
    <Svg>
      <path d="m9 6 6 6-6 6" />
    </Svg>
  );
}

export function ChevronDownIcon() {
  return (
    <Svg>
      <path d="m6 9 6 6 6-6" />
    </Svg>
  );
}

export function DumbbellIcon() {
  return (
    <Svg>
      <path d="M6.5 9.5v5M4.5 10.5v3M9 12h6M17.5 9.5v5M19.5 10.5v3" />
    </Svg>
  );
}

export function CalendarIcon() {
  return (
    <Svg>
      <rect x="4" y="5.5" width="16" height="14" rx="2" />
      <path d="M8 3.5v4M16 3.5v4M4 10h16" />
    </Svg>
  );
}

export function RepeatIcon() {
  return (
    <Svg>
      <path d="M7 8h9a3 3 0 0 1 3 3v1" />
      <path d="m14 5 3 3-3 3" />
      <path d="M17 16H8a3 3 0 0 1-3-3v-1" />
      <path d="m10 19-3-3 3-3" />
    </Svg>
  );
}

export function LayersIcon() {
  return (
    <Svg>
      <path d="m12 4 8 4-8 4-8-4 8-4Z" />
      <path d="m4 12 8 4 8-4" />
      <path d="m4 16 8 4 8-4" />
    </Svg>
  );
}

export function PencilIcon() {
  return (
    <Svg>
      <path d="M4 20h4l11-11-4-4L4 16v4Z" />
      <path d="m13 7 4 4" />
    </Svg>
  );
}

export function SaveIcon() {
  return (
    <Svg>
      <path d="M5 4.5h11l3.5 3.5V19.5H5v-15Z" />
      <path d="M8 4.5V9h6.5" />
      <path d="M8 19.5v-5h8v5" />
    </Svg>
  );
}
