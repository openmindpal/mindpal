"use client";
import { Toaster as SonnerToaster, toast } from "sonner";

function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      toastOptions={{
        style: {
          background: "var(--color-surface-raised)",
          color: "var(--color-text)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-md)",
          boxShadow: "var(--shadow-md)",
          fontSize: "var(--text-sm)",
        },
      }}
      closeButton
      richColors
      duration={3000}
    />
  );
}

export { Toaster, toast };
