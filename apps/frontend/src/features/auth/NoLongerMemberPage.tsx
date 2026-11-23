import { Button } from "@/shared/ui/button";
import { AuthFrame, FormHeading } from "@/features/auth/AuthForm";
import { useSignOut } from "@/features/auth/useSignOut";

// Removed from the organization, the account still signs in and the server refuses it everywhere.
export function NoLongerMemberPage(): React.JSX.Element {
  const signOut = useSignOut();
  return (
    <AuthFrame>
      <div className="flex flex-col gap-6">
        <FormHeading>You are no longer a member</FormHeading>
        <p className="m-0 type-body text-ink-muted">
          You no longer have access to this organization. Ask an admin to invite
          you again.
        </p>
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          disabled={signOut.isPending}
          onClick={() => signOut.mutate()}
        >
          Sign out
        </Button>
      </div>
    </AuthFrame>
  );
}
