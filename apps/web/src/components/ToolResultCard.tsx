import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function ToolResultCard({
  content,
  isError,
}: {
  toolUseId?: string;
  content: string;
  isError?: boolean;
}) {
  return (
    <Card
      className={cn(
        "border-l-4 my-2 bg-muted/30",
        isError ? "border-l-destructive" : "border-l-green-500",
      )}
    >
      <CardContent className="p-3">
        <p className="text-xs text-muted-foreground mb-1">Result</p>
        <pre
          className={cn(
            "text-xs whitespace-pre-wrap max-h-40 overflow-y-auto",
            isError && "text-destructive",
          )}
        >
          {content}
        </pre>
      </CardContent>
    </Card>
  );
}
