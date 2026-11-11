// Practice night from the command line:  npx tsx scripts/rehearsal.ts /tmp/ns-practice
import { createPractice } from "../src/practice.js";
const { dir, clones } = createPractice(process.argv[2] ?? "/tmp/ns-practice");
console.log(`Practice team ready in ${dir}`);
for (const [id, c] of Object.entries(clones)) console.log(`  (cd ${c} && nightshift start --node ${id} --skip-preflight --no-dashboard)`);
