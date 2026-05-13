"use client";
import * as React from "react";
import { cn } from "@/shared/lib/cn";

interface AvatarProps extends React.HTMLAttributes<HTMLDivElement> {
  src?: string | null;
  alt?: string;
  fallback?: string;
  size?: "sm" | "md" | "lg";
}

const sizeClasses = {
  sm: "h-8 w-8 text-[var(--text-xs)]",
  md: "h-10 w-10 text-[var(--text-sm)]",
  lg: "h-12 w-12 text-[var(--text-base)]",
};

const Avatar = React.forwardRef<HTMLDivElement, AvatarProps>(
  ({ className, src, alt, fallback, size = "md", ...props }, ref) => {
    const [imgError, setImgError] = React.useState(false);
    const initials = fallback || alt?.charAt(0)?.toUpperCase() || "?";

    return (
      <div
        ref={ref}
        className={cn(
          "relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--color-surface-sunken)] text-[var(--color-text-secondary)] font-medium select-none",
          sizeClasses[size],
          className
        )}
        {...props}
      >
        {src && !imgError ? (
          <img
            src={src}
            alt={alt || ""}
            className="aspect-square h-full w-full object-cover"
            onError={() => setImgError(true)}
          />
        ) : (
          <span>{initials}</span>
        )}
      </div>
    );
  }
);
Avatar.displayName = "Avatar";
export { Avatar, type AvatarProps };
