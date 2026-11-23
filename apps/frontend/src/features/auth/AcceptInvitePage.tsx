import { useState } from "react";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { PASSWORD_MIN_LENGTH } from "@nightwarden/shared";
import type { InvitationPreview } from "@nightwarden/shared";

import { api, dataOrThrow } from "@/shared/api/client";
import { ROLE_LABEL } from "@/shared/lib/roles";
import { Button, buttonVariants } from "@/shared/ui/button";
import { FieldError } from "@/shared/ui/field";
import { AuthField, AuthFrame, FormHeading } from "@/features/auth/AuthForm";
import { authSessionQuery, invitationQuery } from "@/features/auth/queries";
import { useEnterApp } from "@/features/auth/useEnterApp";
import { useSignOut } from "@/features/auth/useSignOut";

function Unusable({
  heading,
  children,
}: {
  heading: string;
  children: string;
}): React.JSX.Element {
  return (
    <AuthFrame>
      <div className="flex flex-col gap-6">
        <FormHeading>{heading}</FormHeading>
        <p className="m-0 type-body text-ink-muted">{children}</p>
      </div>
    </AuthFrame>
  );
}

function Invited({
  invitation,
}: {
  invitation: InvitationPreview;
}): React.JSX.Element {
  return (
    <p className="m-0 type-body text-ink-muted">
      {invitation.inviterName === null
        ? "You are invited"
        : `${invitation.inviterName} invited you`}{" "}
      to join {invitation.organizationName} as {ROLE_LABEL[invitation.role]}.
    </p>
  );
}

function NewAccountForm({
  token,
  invitation,
}: {
  token: string;
  invitation: InvitationPreview;
}): React.JSX.Element {
  const enter = useEnterApp();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const accept = useMutation({
    mutationFn: () =>
      dataOrThrow(
        api.POST("/api/invitations/{token}/accept", {
          params: { path: { token } },
          body: { name: name.trim(), password },
        }),
      ),
    onSuccess: enter,
  });
  const tooShort = password.length < PASSWORD_MIN_LENGTH;

  return (
    <AuthFrame>
      <form
        className="flex flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (!tooShort) accept.mutate();
        }}
      >
        <div className="flex flex-col gap-2">
          <FormHeading>Create your account</FormHeading>
          <Invited invitation={invitation} />
          <p className="m-0 type-body text-ink-muted">
            You will join as {invitation.email}.
          </p>
        </div>
        <AuthField
          id="invite-name"
          label="Name"
          type="text"
          value={name}
          onChange={setName}
        />
        <AuthField
          id="invite-password"
          label="Password"
          type="password"
          value={password}
          description={`At least ${PASSWORD_MIN_LENGTH} characters.`}
          onChange={setPassword}
        />
        <div className="flex flex-col gap-2">
          {accept.error && <FieldError>{accept.error.message}</FieldError>}
          <Button
            type="submit"
            className="w-full"
            disabled={accept.isPending || tooShort}
          >
            Create account and join
          </Button>
        </div>
      </form>
    </AuthFrame>
  );
}

/* An existing account signs in on the sign-in page, its MFA included, and comes
   back here to join. This page never asks for its password. */
function ExistingAccount({
  token,
  invitation,
}: {
  token: string;
  invitation: InvitationPreview;
}): React.JSX.Element {
  const { data: session } = useSuspenseQuery(authSessionQuery());
  const enter = useEnterApp();
  const here = `/invite/${token}`;
  const signOut = useSignOut({ redirect: here });
  const join = useMutation({
    mutationFn: () =>
      dataOrThrow(
        api.POST("/api/invitations/{token}/accept", {
          params: { path: { token } },
          body: {},
        }),
      ),
    onSuccess: enter,
  });

  if (session === null) {
    return (
      <AuthFrame>
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <FormHeading>Sign in to accept</FormHeading>
            <Invited invitation={invitation} />
            <p className="m-0 type-body text-ink-muted">
              Sign in as {invitation.email}, and you come back here to join.
            </p>
          </div>
          <Link
            to="/login"
            search={{ redirect: here }}
            className={buttonVariants({ className: "w-full" })}
          >
            Sign in
          </Link>
        </div>
      </AuthFrame>
    );
  }

  if (session.user.email !== invitation.email) {
    return (
      <AuthFrame>
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <FormHeading>This invitation is for {invitation.email}</FormHeading>
            <p className="m-0 type-body text-ink-muted">
              You are signed in as {session.user.email}. Sign out, then sign in
              as {invitation.email} to accept.
            </p>
          </div>
          <Button
            type="button"
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

  return (
    <AuthFrame>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <FormHeading>Join {invitation.organizationName}</FormHeading>
          <Invited invitation={invitation} />
        </div>
        <div className="flex flex-col gap-2">
          {join.error && <FieldError>{join.error.message}</FieldError>}
          <Button
            type="button"
            className="w-full"
            disabled={join.isPending}
            onClick={() => join.mutate()}
          >
            Join {invitation.organizationName}
          </Button>
        </div>
      </div>
    </AuthFrame>
  );
}

// A link that has lapsed or never worked says so plainly; there is nothing to fill in.
export function AcceptInvitePage(): React.JSX.Element {
  const { token } = useParams({ from: "/invite/$token" });
  const { data: invitation } = useSuspenseQuery(invitationQuery(token));
  if (invitation === null) {
    return (
      <Unusable heading="This invitation is not valid">
        It may have been canceled or already used. Ask an admin to send a new
        one.
      </Unusable>
    );
  }
  if (invitation.expired) {
    return (
      <Unusable heading="This invitation has expired">
        Ask an admin to send a new one.
      </Unusable>
    );
  }
  return invitation.accountExists ? (
    <ExistingAccount token={token} invitation={invitation} />
  ) : (
    <NewAccountForm token={token} invitation={invitation} />
  );
}
