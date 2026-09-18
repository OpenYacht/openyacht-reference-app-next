import packageJson from "@/package.json";

/** Published as `node.software` and sent as the User-Agent of outbound federation requests. */
export const SOFTWARE = `openyacht-reference-next/${packageJson.version}`;
