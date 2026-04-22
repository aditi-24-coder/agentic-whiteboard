import type { ReactNode } from 'react';

/** 20×20 stroke icons drawn in `currentColor`, so they follow the theme like text does. */
const PATHS = {
  select: <path d="M5 3l11 5.5-4.6 1.6L9.8 15z" />,
  hand: (
    <>
      <path d="M10 2.5v15M2.5 10h15" />
      <path d="M7.5 5L10 2.5 12.5 5M7.5 15l2.5 2.5 2.5-2.5M5 7.5L2.5 10 5 12.5M15 7.5l2.5 2.5L15 12.5" />
    </>
  ),
  pen: (
    <>
      <path d="M3.5 16.5l1-3.8L13.3 3.9a1.6 1.6 0 012.3 0l.5.5a1.6 1.6 0 010 2.3L7.3 15.5z" />
      <path d="M11.8 5.4l2.8 2.8" />
    </>
  ),
  rect: <rect x="3" y="5" width="14" height="10" rx="1.5" />,
  ellipse: <ellipse cx="10" cy="10" rx="7" ry="5.5" />,
  diamond: <path d="M10 2.8l7.2 7.2-7.2 7.2L2.8 10z" />,
  arrow: <path d="M3 10h13M12 6l4 4-4 4" />,
  line: <path d="M4 16L16 4" />,
  text: <path d="M4.5 5V3.5h11V5M10 3.5v13M7.5 16.5h5" />,
  sticky: (
    <>
      <path d="M3.5 3.5h13v8.5l-4.5 4.5H3.5z" />
      <path d="M16.5 12H12v4.5" />
    </>
  ),
  box: (
    <>
      <rect x="2.5" y="4.5" width="15" height="11" rx="2" />
      <path d="M2.5 8h15" />
    </>
  ),
  file: (
    <>
      <path d="M5 2.5h6.5L15 6v11.5H5z" />
      <path d="M11.5 2.5V6H15M7.5 10h5M7.5 13h5" />
    </>
  ),
  frame: <path d="M6 3v14M14 3v14M3 6h14M3 14h14" />,
  minus: <path d="M5 10h10" />,
  plus: <path d="M10 5v10M5 10h10" />,
  fit: <path d="M3 7.5V3h4.5M12.5 3H17v4.5M17 12.5V17h-4.5M7.5 17H3v-4.5" />,
  sliders: <path d="M4 5h12M4 10h12M4 15h12M7 3.5v3M13 8.5v3M9 13.5v3" />,
  layout: (
    <>
      <rect x="2.5" y="3" width="5" height="4" rx="1" />
      <rect x="12.5" y="3" width="5" height="4" rx="1" />
      <rect x="7.5" y="13" width="5" height="4" rx="1" />
      <path d="M5 7v2.5h10V7M10 9.5V13" />
    </>
  ),
  export: <path d="M10 3v9M6.5 6.5L10 3l3.5 3.5M4 12v4.5h12V12" />,
  code: <path d="M7 5.5L2.5 10 7 14.5M13 5.5l4.5 4.5-4.5 4.5M11.2 3.5l-2.4 13" />,
  undo: <path d="M7 4.5L3.5 8 7 11.5M3.5 8H12a4.5 4.5 0 010 9H9" />,
  redo: <path d="M13 4.5L16.5 8 13 11.5M16.5 8H8a4.5 4.5 0 000 9h3" />,
  chevron: <path d="M6 8l4 4 4-4" />,
  alignLeft: <path d="M3.5 5h13M3.5 10h8M3.5 15h11" />,
  alignCenter: <path d="M3.5 5h13M6 10h8M4.5 15h11" />,
  alignRight: <path d="M3.5 5h13M8.5 10h8M5.5 15h11" />,
  bold: <path d="M6 3.5h5a3.25 3.25 0 010 6.5H6zM6 10h6a3.25 3.25 0 010 6.5H6z" strokeWidth={2} />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="pc-icon"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
