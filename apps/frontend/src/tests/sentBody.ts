// What a stubbed fetch was sent. A body the app did not send as JSON text fails the test.
export function sentBody(init: unknown): unknown {
  const body =
    typeof init === "object" && init !== null && "body" in init
      ? init.body
      : undefined;
  if (typeof body !== "string") {
    throw new Error("the request carried no JSON body");
  }
  return JSON.parse(body);
}
