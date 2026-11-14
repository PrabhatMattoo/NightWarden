/* The API describes itself in memory and the shared package gets the types of its
   routes. The output is never committed; every check rebuilds it first. */
import { writeFile } from "node:fs/promises";
import openapiTS, { astToString } from "openapi-typescript";
import { describeApi } from "../src/openapi.ts";

const document = await describeApi();

await writeFile(
  new URL("../../../packages/shared/src/openapi.ts", import.meta.url),
  astToString(await openapiTS(document)),
);
