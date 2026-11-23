import { useSuspenseQuery } from "@tanstack/react-query";
import { Navigate, Outlet } from "@tanstack/react-router";

import { NoLongerMemberPage } from "@/features/auth/NoLongerMemberPage";
import { authSessionQuery } from "@/features/auth/queries";
import { roleOf } from "@/features/auth/useCan";
import { FrontendEventsProvider } from "@/shared/events/FrontendEventsProvider";
import { useAppliedTheme } from "@/shared/hooks/useAppliedTheme";
import { Shell } from "@/app/Shell";

/* Every signed-in page sits inside this. The route has already checked the
   session; this one follows it, so a recheck that finds it gone leaves here. */
export function AppLayout(): React.JSX.Element {
  const { data: session } = useSuspenseQuery(authSessionQuery());
  useAppliedTheme(session?.user.theme ?? null);
  if (session === null) return <Navigate to="/login" replace />;
  if (roleOf(session) === null) return <NoLongerMemberPage />;
  return (
    <FrontendEventsProvider>
      <Shell>
        <Outlet />
      </Shell>
    </FrontendEventsProvider>
  );
}
