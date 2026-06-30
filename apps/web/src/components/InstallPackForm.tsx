"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useInstallGitPack, useUploadZipPack } from "@/features/skill-packs/hooks";

const gitFormSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  description: z.string().trim().min(1, "Description is required"),
  url: z.string().trim().min(1, "URL is required"),
  ref: z.string().trim().optional(),
});

const zipFormSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  description: z.string().trim().min(1, "Description is required"),
});

export function InstallPackForm({ onDone }: { onDone: () => void }) {
  const [tab, setTab] = useState<"git" | "zip">("git");

  const gitForm = useForm<z.infer<typeof gitFormSchema>>({
    resolver: zodResolver(gitFormSchema),
    defaultValues: { name: "", description: "", url: "", ref: "" },
  });

  const zipForm = useForm<z.infer<typeof zipFormSchema>>({
    resolver: zodResolver(zipFormSchema),
    defaultValues: { name: "", description: "" },
  });

  const [zipFile, setZipFile] = useState<File | null>(null);

  const gitMutation = useInstallGitPack();
  const zipMutation = useUploadZipPack();

  const onSubmitGit = async (values: z.infer<typeof gitFormSchema>) => {
    try {
      await gitMutation.mutateAsync(values);
      toast.success(`Installing "${values.name}"...`);
      gitForm.reset();
      onDone();
    } catch (e) {
      toast.error(`Failed: ${(e as Error).message}`);
    }
  };

  const onSubmitZip = async (values: z.infer<typeof zipFormSchema>) => {
    if (!zipFile) {
      toast.error("Please select a zip file");
      return;
    }
    try {
      const fd = new FormData();
      fd.append("name", values.name);
      fd.append("description", values.description);
      fd.append("file", zipFile);
      await zipMutation.mutateAsync(fd);
      toast.success(`Installing "${values.name}"...`);
      zipForm.reset();
      setZipFile(null);
      onDone();
    } catch (e) {
      toast.error(`Failed: ${(e as Error).message}`);
    }
  };

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as "git" | "zip")}>
      <TabsList className="mb-4">
        <TabsTrigger value="git">From Git</TabsTrigger>
        <TabsTrigger value="zip">Upload ZIP</TabsTrigger>
      </TabsList>

      <TabsContent value="git">
        <Form {...gitForm}>
          <form onSubmit={gitForm.handleSubmit(onSubmitGit)} className="space-y-3">
            <FormField
              control={gitForm.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="My Skill Pack" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={gitForm.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Input placeholder="What this pack contains" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={gitForm.control}
              name="url"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Git URL</FormLabel>
                  <FormControl>
                    <Input placeholder="https://github.com/..." {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={gitForm.control}
              name="ref"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Branch / Tag (optional)</FormLabel>
                  <FormControl>
                    <Input placeholder="main" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button type="submit" disabled={gitMutation.isPending}>
              {gitMutation.isPending ? "Installing…" : "Install from Git"}
            </Button>
          </form>
        </Form>
      </TabsContent>

      <TabsContent value="zip">
        <Form {...zipForm}>
          <form onSubmit={zipForm.handleSubmit(onSubmitZip)} className="space-y-3">
            <FormField
              control={zipForm.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="My Skill Pack" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={zipForm.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Input placeholder="What this pack contains" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormItem>
              <FormLabel>ZIP File</FormLabel>
              <FormControl>
                <Input
                  type="file"
                  accept=".zip"
                  onChange={(e) => setZipFile(e.target.files?.[0] ?? null)}
                />
              </FormControl>
            </FormItem>
            <Button type="submit" disabled={zipMutation.isPending || !zipFile}>
              {zipMutation.isPending ? "Installing…" : "Install from ZIP"}
            </Button>
          </form>
        </Form>
      </TabsContent>
    </Tabs>
  );
}
