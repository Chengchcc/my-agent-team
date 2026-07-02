export const loopKeys = {
  all: ["loops"] as const,
  detail: (id: string) => ["loops", id] as const,
};
