import type { JSX, SVGProps } from 'react';

/**
 * DisFAP Brand Mark — An understated geometric emblem representing
 * isolated execution layers, secure telemetry channels, and federated access.
 */
export function BrandMark({ size = 28, className }: { size?: number; className?: string }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <rect x="2" y="2" width="28" height="28" rx="6" fill="#090d16" stroke="#243044" strokeWidth="1.5" />
      {/* Outer isolation boundary */}
      <path
        d="M8 12C8 9.79086 9.79086 8 12 8H20C22.2091 8 24 9.79086 24 12V20C24 22.2091 22.2091 24 20 24H12C9.79086 24 8 22.2091 8 20V12Z"
        stroke="#0284c7"
        strokeWidth="1.75"
        strokeDasharray="2 2"
      />
      {/* Core execution kernel */}
      <rect x="12" y="12" width="8" height="8" rx="2" fill="#0284c7" />
      {/* Dynamic access conduit dots */}
      <circle cx="16" cy="5" r="1.5" fill="#38bdf8" />
      <circle cx="16" cy="27" r="1.5" fill="#38bdf8" />
      <circle cx="5" cy="16" r="1.5" fill="#38bdf8" />
      <circle cx="27" cy="16" r="1.5" fill="#38bdf8" />
    </svg>
  );
}

