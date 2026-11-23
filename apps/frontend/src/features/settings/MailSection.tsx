import { useState } from "react";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  DEFAULT_SMTP_SECURITY,
  SMTP_SECURITIES,
  type MailSettingField,
  type SmtpSecurity,
} from "@nightwarden/shared";

import { api, dataOrThrow } from "@/shared/api/client";
import { toast } from "@/shared/lib/toast";
import { Button } from "@/shared/ui/button";
import { FieldError } from "@/shared/ui/field";
import { Input } from "@/shared/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { mailQuery } from "./queries";
import { rowLabel, SettingsGroup, SettingsRow } from "./SettingsRow";

const SECURITY_LABEL: Record<SmtpSecurity, string> = {
  starttls: "STARTTLS (usually port 587)",
  tls: "TLS (usually port 465)",
  none: "None (plain text)",
};

export function MailSection(): React.JSX.Element {
  const queryClient = useQueryClient();
  const { data: mail } = useSuspenseQuery(mailQuery());
  const [host, setHost] = useState(mail.host ?? "");
  const [port, setPort] = useState(mail.port === null ? "" : String(mail.port));
  const [security, setSecurity] = useState<SmtpSecurity>(
    mail.security ?? DEFAULT_SMTP_SECURITY,
  );
  const [username, setUsername] = useState(mail.username ?? "");
  // Write-only: the saved one is never sent back, so this holds only a new one.
  const [password, setPassword] = useState("");
  const [from, setFrom] = useState(mail.from ?? "");

  const isLocked = (field: MailSettingField): boolean =>
    mail.locked[field] !== undefined;

  const save = useMutation({
    // A field the environment sets is left out, since the server refuses to change it.
    mutationFn: () =>
      dataOrThrow(
        api.PUT("/api/config/mail", {
          body: {
            ...(!isLocked("host") && { host }),
            ...(!isLocked("port") && { port: Number(port) }),
            ...(!isLocked("security") && { security }),
            ...(!isLocked("username") && {
              username: username === "" ? null : username,
            }),
            ...(!isLocked("password") && password !== "" && { password }),
            ...(!isLocked("from") && { from }),
          },
        }),
      ),
    onSuccess: (saved) => {
      queryClient.setQueryData(mailQuery().queryKey, saved);
      setPassword("");
      toast.success("Email settings saved");
    },
  });

  // The server needs all three before it can try a connection.
  const complete =
    (host !== "" || isLocked("host")) &&
    (port !== "" || isLocked("port")) &&
    (from !== "" || isLocked("from"));

  return (
    <div className="flex flex-col gap-3">
      <SettingsGroup lead="NightWarden sends email through your own SMTP server. Saving connects to it first, and nothing is saved if it refuses.">
        <SettingsRow
          id="settings-mail-host"
          title="Host"
          description="The SMTP server's address."
          lockedBy={mail.locked.host}
        >
          <Input
            aria-labelledby={rowLabel("settings-mail-host")}
            measure="beside"
            placeholder="smtp.example.com"
            disabled={isLocked("host")}
            value={host}
            onChange={(e) => setHost(e.currentTarget.value)}
          />
        </SettingsRow>
        <SettingsRow
          id="settings-mail-port"
          title="Port"
          lockedBy={mail.locked.port}
        >
          <Input
            aria-labelledby={rowLabel("settings-mail-port")}
            measure="beside"
            type="number"
            min={1}
            max={65535}
            disabled={isLocked("port")}
            value={port}
            onChange={(e) => setPort(e.currentTarget.value)}
          />
        </SettingsRow>
        <SettingsRow
          id="settings-mail-security"
          title="Security"
          description="How the connection is protected."
          lockedBy={mail.locked.security}
        >
          <Select
            items={SECURITY_LABEL}
            disabled={isLocked("security")}
            value={security}
            onValueChange={(value) =>
              setSecurity(
                SMTP_SECURITIES.find((s) => s === value) ??
                  DEFAULT_SMTP_SECURITY,
              )
            }
          >
            <SelectTrigger aria-labelledby={rowLabel("settings-mail-security")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(SECURITY_LABEL).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          id="settings-mail-username"
          title="Username"
          description="Leave empty for a server that takes no login."
          lockedBy={mail.locked.username}
        >
          <Input
            aria-labelledby={rowLabel("settings-mail-username")}
            measure="beside"
            autoComplete="off"
            disabled={isLocked("username")}
            value={username}
            onChange={(e) => setUsername(e.currentTarget.value)}
          />
        </SettingsRow>
        <SettingsRow
          id="settings-mail-password"
          title="Password"
          description="Stored encrypted. Type a new one to replace it."
          lockedBy={mail.locked.password}
        >
          <Input
            aria-labelledby={rowLabel("settings-mail-password")}
            measure="beside"
            type="password"
            autoComplete="new-password"
            placeholder={mail.passwordSet ? "••••••••" : ""}
            disabled={isLocked("password")}
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
          />
        </SettingsRow>
        <SettingsRow
          id="settings-mail-from"
          title="From"
          description="The sender address on every message."
          lockedBy={mail.locked.from}
        >
          <Input
            aria-labelledby={rowLabel("settings-mail-from")}
            measure="beside"
            placeholder="NightWarden <nightwarden@example.com>"
            disabled={isLocked("from")}
            value={from}
            onChange={(e) => setFrom(e.currentTarget.value)}
          />
        </SettingsRow>
      </SettingsGroup>

      <div className="flex items-center justify-end gap-3">
        {save.error && <FieldError>{save.error.message}</FieldError>}
        <Button
          type="button"
          disabled={!complete || save.isPending}
          onClick={() => save.mutate()}
        >
          Save
        </Button>
      </div>
    </div>
  );
}
