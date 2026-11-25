"use client";

import type { WorkflowDefinition } from "@chengchenccc/workflow";
import { Plus, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { t } from "@/lib/i18n";
import { formatNextRun, nextCronRun } from "./cron-next";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type Mode = "daily" | "hourly" | "weekly" | "weekdays" | "custom";

const FIELD_CLASS = "h-8 min-w-28 flex-1 border-(--hairline) bg-(--canvas) text-xs";

/** Human sentence for a 5-field cron expression; falls back to the raw expr. */
export function describeCron(expr: string): string {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) {
    return expr;
  }
  const [min, hour, , , dow] = f;
  const hh = String(Number(hour)).padStart(2, "0");
  const mm = String(Number(min)).padStart(2, "0");
  const hm = `${hh}:${mm}`;
  if (dow === "1-5") {
    return `Weekdays ${hm}`;
  }
  if (dow !== undefined && /^[0-6]$/.test(dow)) {
    return `${WEEKDAYS[Number(dow)] ?? ""} ${hm}`;
  }
  if (hour === "*") {
    return `Every hour at ${mm} min`;
  }
  return `Daily ${hm}`;
}

function buildCron(mode: Mode, time: string, weekday: number): string {
  const [h, m] = time.split(":").map(Number);
  const hh = Number.isInteger(h) ? h : 2;
  const mm = Number.isInteger(m) ? m : 0;
  switch (mode) {
    case "daily":
      return `${mm} ${hh} * * *`;
    case "hourly":
      return `${mm} * * * *`;
    case "weekly":
      return `${mm} ${hh} * * ${weekday}`;
    case "weekdays":
      return `${mm} ${hh} * * 1-5`;
    default:
      return "";
  }
}

function modeOf(value: string | null): Mode {
  if (value === null) {
    return "daily";
  }
  return value as Mode;
}

/** `HH:MM` for the hourly mode's minute field, kept inside the hour. */
function minuteTime(raw: string): string {
  const parsed = Number(raw);
  const clamped = Number.isFinite(parsed) ? Math.min(59, Math.max(0, parsed)) : 0;
  return `00:${String(clamped).padStart(2, "0")}`;
}

/** How a workflow may be started, beside a schedule. */
const WAYS: ReadonlyArray<readonly [string, string]> = [
  ["Manual", "Run from the overview, the list or the API; nothing to declare."],
  [
    "API",
    "POST /api/workflow-executions with the workflow file and the input; nothing to declare.",
  ],
];

/** The saved schedules of a workflow, edited in place. Every change here is part of the
 *  definition: a schedule is on or off only once the definition is saved with it, and a run is
 *  started elsewhere. */
export function TriggerPanel({
  definition,
  onChange,
}: {
  definition: WorkflowDefinition;
  onChange: (def: WorkflowDefinition) => void;
}) {
  const [mode, setMode] = useState<Mode>("daily");
  const [time, setTime] = useState("02:00");
  const [weekday, setWeekday] = useState(1);
  const [custom, setCustom] = useState("");
  const triggers = definition.triggers ?? [];

  function setTriggers(next: WorkflowDefinition["triggers"]) {
    onChange({ ...definition, triggers: next });
  }

  function add(): void {
    if (pendingCron === "") {
      return;
    }
    // Only ONE cron trigger is meaningful: a workflow has a single schedule. Adding replaces the
    // existing one, or sets the first.
    setTriggers([{ type: "cron", cron: pendingCron }]);
    setCustom("");
  }

  function remove(index: number): void {
    setTriggers(triggers.filter((_, i) => i !== index));
  }

  function setEnabled(index: number, enabled: boolean): void {
    const next = triggers.map((trigger, i) => {
      if (i !== index) {
        return trigger;
      }
      return { ...trigger, enabled };
    });
    setTriggers(next);
  }

  const pendingCron = mode === "custom" ? custom.trim() : buildCron(mode, time, weekday);
  const preview = pendingCron === "" ? null : nextCronRun(pendingCron);

  let field: ReactNode = (
    <Input
      type="time"
      className={FIELD_CLASS}
      value={time}
      onChange={(event) => setTime(event.target.value)}
    />
  );
  if (mode === "hourly") {
    field = (
      <Input
        type="number"
        min={0}
        max={59}
        className={FIELD_CLASS}
        value={time.split(":")[1] ?? "0"}
        onChange={(event) => setTime(minuteTime(event.target.value))}
      />
    );
  } else if (mode === "weekly") {
    field = (
      <>
        <Select value={String(weekday)} onValueChange={(next) => setWeekday(Number(next ?? "1"))}>
          <SelectTrigger className="h-8 w-18 min-w-0 shrink-0 border-(--hairline) bg-(--canvas) text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WEEKDAYS.map((d, i) => (
              <SelectItem key={d} value={String(i)}>
                {d}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="time"
          className={FIELD_CLASS}
          value={time}
          onChange={(event) => setTime(event.target.value)}
        />
      </>
    );
  } else if (mode === "custom") {
    field = (
      <Input
        className={`${FIELD_CLASS} font-mono`}
        placeholder={t("min hour dom mon dow")}
        value={custom}
        onChange={(event) => setCustom(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            add();
          }
        }}
      />
    );
  }

  return (
    <div className="space-y-4 p-4">
      <div className="space-y-2.5 rounded-lg border border-(--hairline) bg-(--canvas)/50 p-3">
        <Label className="text-xs text-(--mute)">{t("Add a schedule (one at most)")}</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={mode} onValueChange={(next) => setMode(modeOf(next))}>
            <SelectTrigger className="h-8 w-26 min-w-0 shrink-0 border-(--hairline) bg-(--canvas) text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">{t("Daily")}</SelectItem>
              <SelectItem value="hourly">{t("Hourly")}</SelectItem>
              <SelectItem value="weekly">{t("Weekly")}</SelectItem>
              <SelectItem value="weekdays">{t("Weekdays")}</SelectItem>
              <SelectItem value="custom">{t("Custom")}</SelectItem>
            </SelectContent>
          </Select>
          {field}
          <Button size="sm" className="shrink-0" onClick={add}>
            <Plus />
            {t("Add")}
          </Button>
        </div>
        {pendingCron !== "" && (
          <p className={`text-[10px] ${preview === null ? "text-(--err)" : "text-(--mute)"}`}>
            {preview === null
              ? t("Not a cron expression (five fields: minute hour day month weekday)")
              : t("{described} ({cron}) · next run {when}", {
                  described: describeCron(pendingCron),
                  cron: pendingCron,
                  when: formatNextRun(preview),
                })}
          </p>
        )}
      </div>

      {triggers.length === 0 && (
        <p className="text-[10px] text-(--faint)">
          {t("No schedule is saved. The workflow runs when started.")}
        </p>
      )}
      {triggers.map((trigger, index) => {
        const at = nextCronRun(trigger.cron);
        const on = trigger.enabled !== false;
        return (
          <div
            key={`${trigger.cron}-${index}`}
            className="space-y-2 rounded-lg border border-(--hairline) bg-(--canvas)/50 p-3 text-xs"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-(--ink)">{describeCron(trigger.cron)}</p>
                <p className="font-mono text-[10px] text-(--faint)">{trigger.cron}</p>
              </div>
              <Label className="shrink-0 gap-2 text-[11px] font-normal text-(--mute)">
                <Switch
                  size="sm"
                  checked={on}
                  onCheckedChange={(next) => setEnabled(index, next === true)}
                />
                {on ? t("On") : t("Off")}
              </Label>
            </div>
            <div className="flex items-center justify-between gap-2 text-[10px] text-(--mute)">
              <span>
                {at === null ? t("Not a cron expression") : `${t("Next run")} ${formatNextRun(at)}`}
              </span>
              <Button
                size="xs"
                variant="ghost"
                className="text-(--err) hover:text-(--err)"
                onClick={() => remove(index)}
              >
                <Trash2 />
                {t("Remove")}
              </Button>
            </div>
          </div>
        );
      })}

      <div className="space-y-2 rounded-lg border border-(--hairline) bg-(--canvas)/30 p-3 text-[11px]/relaxed  text-(--mute)">
        {WAYS.map(([way, how]) => (
          <div key={way}>
            <span className="mr-1 font-medium text-(--body)">{t(way)}</span>
            <span>{t(how)}</span>
          </div>
        ))}
      </div>
      <p className="text-[10px]/relaxed  text-(--faint)">
        {t(
          "A schedule is part of the definition: switching it on takes effect when the definition is saved. After three failed runs in a row the scheduler stops firing it until a run succeeds.",
        )}
      </p>
    </div>
  );
}
