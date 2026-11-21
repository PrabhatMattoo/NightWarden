import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/shared/ui/input-group";
import { ICON_UI } from "@/shared/lib/iconProps";

export function PasswordInput(
  props: Omit<React.ComponentProps<typeof InputGroupInput>, "type">,
): React.JSX.Element {
  const [isVisible, setIsVisible] = useState(false);
  const Icon = isVisible ? EyeOff : Eye;
  return (
    <InputGroup>
      <InputGroupInput {...props} type={isVisible ? "text" : "password"} />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          size="icon-xs"
          aria-label={isVisible ? "Hide password" : "Show password"}
          aria-pressed={isVisible}
          onClick={() => setIsVisible(!isVisible)}
        >
          <Icon {...ICON_UI} />
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}
