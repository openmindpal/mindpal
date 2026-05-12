"use client";
import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { motion } from "framer-motion";
import { cn } from "@/shared/lib/cn";
import { fadeSlide } from "@/shared/lib/motion";

const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "inline-flex h-9 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] p-1 text-[var(--color-text-muted)]",
      className
    )}
    {...props}
  />
));
TabsList.displayName = "TabsList";

const TabsTrigger = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "inline-flex items-center justify-center whitespace-nowrap rounded-[var(--radius-sm)] px-3 py-1 text-[var(--text-sm)] font-medium transition-all duration-150 hover:bg-[var(--color-surface-raised)]/60 hover:text-[var(--color-text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-[var(--color-surface-raised)] data-[state=active]:text-[var(--color-text)] data-[state=active]:shadow-sm",
      className
    )}
    {...props}
  />
));
TabsTrigger.displayName = "TabsTrigger";

const TabsContent = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn("mt-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]", className)}
    {...props}
    asChild
  >
    <motion.div variants={fadeSlide} initial="initial" animate="animate" exit="exit" />
  </TabsPrimitive.Content>
));
TabsContent.displayName = "TabsContent";

export { Tabs, TabsList, TabsTrigger, TabsContent };
