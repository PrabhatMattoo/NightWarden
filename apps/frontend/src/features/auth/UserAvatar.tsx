import { Avatar, AvatarFallback, AvatarImage } from "@/shared/ui/avatar";
import { initials } from "@/shared/lib/initials";

// The signed-in person's picture, or their initials on the accent until they add one.
export function UserAvatar({
  name,
  image,
  size = "default",
  ...props
}: {
  name: string;
  image: string | null;
  size?: "default" | "sm";
} & React.AriaAttributes): React.JSX.Element {
  return (
    <Avatar size={size} {...props}>
      {image !== null && <AvatarImage src={image} alt="" />}
      <AvatarFallback>{initials(name, size === "sm" ? 1 : 2)}</AvatarFallback>
    </Avatar>
  );
}
