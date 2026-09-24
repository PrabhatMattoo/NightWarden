import { useSuspenseQuery } from "@tanstack/react-query";
import { Navigate, Outlet } from "@tanstack/react-router";

import { authStatusQuery, isSignedIn } from "@/features/auth/queries";
import { FrontendEventsProvider } from "@/shared/events/FrontendEventsProvider";
import { useAppliedTheme } from "@/shared/hooks/useAppliedTheme";
import { Shell } from "@/app/Shell";

/* Every signed-in page sits inside this. The route has already checked the
   session; this one follows it, so a recheck that finds it gone leaves here. */
export function AppLayout(): React.JSX.Element {
  const { data: status } = useSuspenseQuery(authStatusQuery());
  useAppliedTheme(isSignedIn(status) ? status.theme : null);
  if (!isSignedIn(status)) return <Navigate to="/login" replace />;
  return (
    <FrontendEventsProvider>
      <Shell>
        <Outlet />
      </Shell>
    </FrontendEventsProvider>
  );
}
