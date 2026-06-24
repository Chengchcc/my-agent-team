"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, type CronJobRow } from "@/lib/api";
import { fieldClass, labelClass } from "@/lib/form-styles";

const formSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  agentId: z.string().trim().min(1, "Agent is required"),
  cronExpr: z
    .string()
    .trim()
    .regex(/^(\S+\s+){4}\S+$/, "Must be a 5-field cron expression"),
  prompt: z.string().optional().default(""),
  timeoutMs: z.coerce.number().int().nonnegative().optional().default(0),
  maxRetries: z.coerce.number().int().nonnegative().optional().default(0),
  enabled: z.boolean().default(false),
});
type FormValues = z.infer<typeof formSchema>;

interface CronJobFormProps {
  editCronJob?: CronJobRow;
  onSuccess?: () => void;
}

export function CronJobForm({ editCronJob, onSuccess }: CronJobFormProps) {
  const qc = useQueryClient();
  const isEdit = !!editCronJob;
  const [open, setOpen] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const { data: agentsData } = useQuery({ queryKey: ["agents"], queryFn: api.listAgents });
  const agents = (agentsData ?? []).filter((a) => !a.archivedAt);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      agentId: "",
      cronExpr: "",
      prompt: "",
      timeoutMs: 0,
      maxRetries: 0,
      enabled: false,
    },
  });

  useEffect(() => {
    if (editCronJob) {
      setOpen(true);
      form.reset({
        name: editCronJob.name,
        agentId: editCronJob.agentId,
        cronExpr: editCronJob.cronExpr,
        prompt: editCronJob.prompt,
        timeoutMs: editCronJob.timeoutMs,
        maxRetries: editCronJob.maxRetries,
        enabled: editCronJob.enabled,
      });
    }
  }, [editCronJob, form]);

  function handleOpen(o: boolean) {
    if (!o) {
      if (isEdit && editCronJob) {
        form.reset({
          name: editCronJob.name,
          agentId: editCronJob.agentId,
          cronExpr: editCronJob.cronExpr,
          prompt: editCronJob.prompt,
          timeoutMs: editCronJob.timeoutMs,
          maxRetries: editCronJob.maxRetries,
          enabled: editCronJob.enabled,
        });
      } else {
        form.reset();
      }
      setServerError(null);
    }
    setOpen(o);
  }

  const createMu = useMutation({
    mutationFn: api.createCronJob,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cron-jobs"] });
      toast.success("Schedule created");
      setOpen(false);
      onSuccess?.();
    },
    onError: (e) => {
      setServerError(String(e));
      toast.error("Failed to create schedule");
    },
  });

  const updateMu = useMutation({
    mutationFn: (body: Parameters<typeof api.updateCronJob>[1]) =>
      api.updateCronJob(editCronJob!.cronJobId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cron-jobs"] });
      toast.success("Schedule updated");
      setOpen(false);
      onSuccess?.();
    },
    onError: (e) => {
      setServerError(String(e));
      toast.error("Failed to update schedule");
    },
  });

  function onSubmit(values: FormValues) {
    setServerError(null);
    if (isEdit) {
      // PATCH /cron-jobs/:id does not accept `enabled` (it is toggled via the
      // dedicated /enable endpoint). The server's updateSchema is .strict(), so
      // leaving `enabled` in the body makes every save 400. Strip it here.
      const { enabled: _enabled, ...patch } = values;
      updateMu.mutate(patch);
    } else {
      createMu.mutate(values);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      {!isEdit && (
        <DialogTrigger className="bg-[var(--primary)] text-[var(--on-primary)] rounded-md px-5 py-2 text-sm font-semibold hover:opacity-90 transition-opacity duration-200">
          + New Schedule
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Schedule" : "New Schedule"}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className={labelClass}>Name</FormLabel>
                  <FormControl>
                    <Input {...field} className={fieldClass} placeholder="Daily patrol" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="agentId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className={labelClass}>Agent</FormLabel>
                  <FormControl>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger className={fieldClass}>
                        <SelectValue placeholder="Select agent..." />
                      </SelectTrigger>
                      <SelectContent>
                        {agents.map((a) => (
                          <SelectItem key={a.id} value={a.id}>
                            {a.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="cronExpr"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className={labelClass}>Cron Expression</FormLabel>
                  <FormControl>
                    <Input {...field} className={fieldClass} placeholder="0 9 * * *" />
                  </FormControl>
                  <p className="text-[10px] text-[var(--mute)] mt-1">
                    5-field expression, interpreted in UTC
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="prompt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className={labelClass}>Prompt</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      className={fieldClass}
                      placeholder="What to tell the agent on each fire"
                      rows={3}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="timeoutMs"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className={labelClass}>Timeout (ms)</FormLabel>
                    <FormControl>
                      <Input {...field} type="number" className={fieldClass} placeholder="0" />
                    </FormControl>
                    <p className="text-[10px] text-[var(--mute)] mt-1">0 = no per-job watchdog</p>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="maxRetries"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className={labelClass}>Max Retries</FormLabel>
                    <FormControl>
                      <Input {...field} type="number" className={fieldClass} placeholder="0" />
                    </FormControl>
                    <p className="text-[10px] text-[var(--mute)] mt-1">0 = no retry</p>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="enabled"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center gap-2">
                  <FormControl>
                    <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                  <FormLabel className="text-sm">Enabled</FormLabel>
                </FormItem>
              )}
            />
            {serverError && <p className="text-xs text-destructive">{serverError}</p>}
            <Button
              type="submit"
              className="w-full"
              disabled={form.formState.isSubmitting || createMu.isPending || updateMu.isPending}
            >
              {isEdit ? "Save Changes" : "Create Schedule"}{" "}
              {(createMu.isPending || updateMu.isPending) && (
                <ArrowRight className="ml-2 h-4 w-4 animate-pulse" />
              )}
            </Button>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
