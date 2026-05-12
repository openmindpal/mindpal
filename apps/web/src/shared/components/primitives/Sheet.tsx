"use client";
import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { overlayFade, slideRight } from "@/shared/lib/motion";

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;
const SheetPortal = DialogPrimitive.Portal;

const SheetOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn("fixed inset-0 z-[var(--z-overlay)] bg-[var(--color-overlay)]", className)}
    {...props}
    asChild
  >
    <motion.div variants={overlayFade} initial="initial" animate="animate" exit="exit" />
  </DialogPrimitive.Overlay>
));
SheetOverlay.displayName = "SheetOverlay";

type SheetSide = "top" | "bottom" | "left" | "right";

const sideVariants: Record<SheetSide, string> = {
  top: "inset-x-0 top-0 border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top",
  bottom: "inset-x-0 bottom-0 border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
  left: "inset-y-0 left-0 h-full w-3/4 max-w-sm border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left",
  right: "inset-y-0 right-0 h-full w-3/4 max-w-sm border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right",
};

interface SheetContentProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  side?: SheetSide;
}

const SheetContent = React.forwardRef<React.ComponentRef<typeof DialogPrimitive.Content>, SheetContentProps>(
  ({ side = "right", className, children, ...props }, ref) => (
    <SheetPortal>
      <SheetOverlay />
      <AnimatePresence>
        <DialogPrimitive.Content
          ref={ref}
          className={cn(
            "fixed z-[var(--z-modal)] gap-4 border-[var(--color-border)] bg-[var(--color-surface-raised)] p-6 shadow-xl transition-all duration-150",
            sideVariants[side],
            className
          )}
          asChild
          {...props}
        >
          <motion.div variants={slideRight} initial="initial" animate="animate" exit="exit">
            {children}
            <DialogPrimitive.Close className="absolute right-4 top-4 rounded-[var(--radius-sm)] p-1 text-[var(--color-text-muted)] opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]">
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          </motion.div>
        </DialogPrimitive.Content>
      </AnimatePresence>
    </SheetPortal>
  )
);
SheetContent.displayName = "SheetContent";

function SheetHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col space-y-2 text-left", className)} {...props} />;
}

function SheetFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)} {...props} />;
}

const SheetTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("text-lg font-semibold text-[var(--color-text)]", className)} {...props} />
));
SheetTitle.displayName = "SheetTitle";

const SheetDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("text-[var(--text-sm)] text-[var(--color-text-muted)]", className)} {...props} />
));
SheetDescription.displayName = "SheetDescription";

export { Sheet, SheetTrigger, SheetClose, SheetPortal, SheetOverlay, SheetContent, SheetHeader, SheetFooter, SheetTitle, SheetDescription };
