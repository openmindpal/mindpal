"use client";

import { useState } from "react";
import { TaskList } from "@/features/tasks/components/TaskList";
import { TaskDetailSheet } from "@/features/tasks/components/TaskDetailSheet";
import type { Task } from "@/features/tasks/hooks/useTasks";

export default function TasksPage() {
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const handleSelectTask = (task: Task) => {
    setSelectedTask(task);
    setSheetOpen(true);
  };

  return (
    <div className="flex flex-1 flex-col gap-6 p-8">
      <TaskList onSelectTask={handleSelectTask} />
      <TaskDetailSheet
        task={selectedTask}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
      />
    </div>
  );
}
