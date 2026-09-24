import { render } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";

import { TooltipProvider } from "@/shared/ui/tooltip";
import { SidebarProvider } from "@/shared/ui/sidebar";
import { Toaster } from "@/shared/ui/sonner";
import { createQueryClient } from "@/app/queryClient";
import { createAppRouter } from "@/app/router";

/* The production providers with the app's UI context, for deterministic DOM assertions: TooltipProvider + SidebarProvider back the shadcn components. */
export function TestProviders({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <TooltipProvider>
      <SidebarProvider>
        <Toaster />
        {children}
      </SidebarProvider>
    </TooltipProvider>
  );
}

/* The app as it ships, from its real route tree and query client, opened at
   `path`. Retries are off so a failure lands on the first answer. */
export function renderApp({
  path,
  queryClient = createQueryClient({ retry: false }),
}: {
  path: string;
  queryClient?: QueryClient;
}) {
  const router = createAppRouter({
    queryClient,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(
    <TestProviders>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </TestProviders>,
  );
  return { router, queryClient };
}
