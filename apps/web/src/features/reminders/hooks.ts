import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";

export function useReminders() {
  return useQuery({
    queryKey: ["reminders"],
    queryFn: () => api.listReminders(),
    select: (d) => d.reminders,
    staleTime: 15_000,
  });
}

export function useCreateReminder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.createReminder,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["reminders"] });
      toast.success("Reminder scheduled");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to schedule"),
  });
}

export function useSnoozeReminder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, fireAt }: { id: string; fireAt: number }) => api.snoozeReminder(id, fireAt),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["reminders"] }),
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to snooze"),
  });
}

export function useCancelReminder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.cancelReminder(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["reminders"] }),
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to cancel"),
  });
}
