import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { XTOOEY_CONFIG_JSON_SCHEMA } from "../src/config.js"

writeFileSync(
  join(import.meta.dir, "..", "xtooey.schema.json"),
  `${JSON.stringify(XTOOEY_CONFIG_JSON_SCHEMA, null, 2)}\n`,
)
