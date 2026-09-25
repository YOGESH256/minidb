import { Database } from "../src/index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minidb-bench-"));
const db = new Database(path.join(dir, "b.db"));
db.exec("CREATE TABLE t (id INT PRIMARY KEY, name TEXT NOT NULL, age INT)");
const ins = db.prepare("INSERT INTO t VALUES (?, ?, ?)");
db.transaction(() => {
  for (let i = 1; i <= 50_000; i++)
    ins.run(i, "user" + String(i).padStart(7, "0"), 18 + (i % 50));
})();

const RUNS = 41;
const bench = (label: string, sql: string) => {
  const s = db.prepare(sql);
  for (let i = 0; i < 5; i++) s.all();
  const t: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const a = performance.now();
    s.all();
    t.push(performance.now() - a);
  }
  t.sort((x, y) => x - y);
  const q = (p: number) => t[Math.floor((t.length - 1) * p)]!.toFixed(1);
  console.log(
    `  ${label.padEnd(34)} median ${q(0.5).padStart(6)} ms   p25 ${q(0.25)}  p75 ${q(0.75)}`,
  );
};

console.log(`50,000 rows, prepared, ${RUNS} runs:`);
bench("WHERE name > <text>", "SELECT id FROM t WHERE name > 'user0025000'");
bench("WHERE name = <text>", "SELECT id FROM t WHERE name = 'user0025000'");
bench("WHERE age > 40", "SELECT id FROM t WHERE age > 40");
bench("ORDER BY name", "SELECT name FROM t WHERE age > 60 ORDER BY name");
bench("SELECT id (no predicate)", "SELECT id FROM t");
db.close();
fs.rmSync(dir, { recursive: true, force: true });
