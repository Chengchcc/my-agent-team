"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useProjectList } from "@/features/projects/hooks";
import { useCreateLoop } from "@/features/loop/hooks";

export default function NewLoopPage() {
  const router = useRouter();
  const { data: projects } = useProjectList();
  const createMu = useCreateLoop();

  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [intent, setIntent] = useState("");
  const [cronExpr, setCronExpr] = useState("");

  function handleSubmit() {
    if (!name.trim()) return toast.error("Name is required");

    createMu.mutate(
      { name: name.trim(), intent: intent.trim() || undefined, projectId: projectId || undefined, cronExpr: cronExpr || undefined },
      {
        onSuccess: (data) => {
          toast.success("Loop created");
          router.push(`/loops/${data.loop.id}`);
        },
        onError: (e) => toast.error(`Create failed: ${String(e)}`),
      },
    );
  }

  return (
    <div className="h-full bg-[var(--canvas)]">
      <div className="border-b border-[var(--hairline)]">
        <div className="container mx-auto px-8 py-5">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem><a href="/loops">Loops</a></BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem><BreadcrumbPage>New Loop</BreadcrumbPage></BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </div>

      <div className="container mx-auto px-8 py-10 max-w-lg">
        <Card>
          <CardContent className="p-6 space-y-4">
            <div>
              <Label htmlFor="name">Name *</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)}
                     placeholder="Morning Triage" />
            </div>

            <div>
              <Label htmlFor="project">Project</Label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger id="project"><SelectValue placeholder="Select a project..." /></SelectTrigger>
                <SelectContent>
                  {(projects?.projects ?? []).map((p) => (
                    <SelectItem key={p.projectId} value={p.projectId}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label htmlFor="intent">Intent</Label>
              <Textarea id="intent" value={intent} onChange={(e) => setIntent(e.target.value)}
                        placeholder="每天早上检查 CI 失败，自动修简单的" rows={3} />
            </div>

            <div>
              <Label htmlFor="cronExpr">Schedule (optional)</Label>
              <Select value={cronExpr} onValueChange={setCronExpr}>
                <SelectTrigger id="cronExpr"><SelectValue placeholder="Manual (no schedule)" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="0 8 * * *">Daily 8:00 AM</SelectItem>
                  <SelectItem value="*/15 * * * *">Every 15 minutes</SelectItem>
                  <SelectItem value="0 */2 * * *">Every 2 hours</SelectItem>
                  <SelectItem value="0 */6 * * *">Every 6 hours</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => router.push("/loops")}>Cancel</Button>
              <Button onClick={handleSubmit} disabled={createMu.isPending}>Create Loop</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
