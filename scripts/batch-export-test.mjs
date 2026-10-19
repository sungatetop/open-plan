/**
 * 批量导出（G7）纯函数回归：计划展开 / 去重 / 上限 / 校验 / 尺寸钳制 / 文件名清洗 / 队列编排。
 * 运行：node scripts/batch-export-test.mjs
 */
import assert from "node:assert/strict";
import {
  EXPORT_SIZES, MAX_JOBS, CUSTOM_SIZE_LIMITS,
  planExportJobs, runExportQueue,
} from "../server/batch-export.mjs";

const passed = [];
function check(name, fn) {
  try { fn(); passed.push(name); console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log("▶ planExportJobs 计划展开");
check("基础展开 = 项目×组合×尺寸×格式", () => {
  const plan = planExportJobs({ projects: ["a", "b"], sizes: ["a4l", "a4p"], formats: ["png"] });
  assert.equal(plan.errors.length, 0);
  assert.equal(plan.jobs.length, 2 * 1 * 2 * 1);
  assert.deepEqual(plan.jobs[0], {
    id: "job-1", project: "a", layers: [], sizeId: "a4l", sizeLabel: EXPORT_SIZES.a4l.label,
    width: 1600, height: 1131, format: "png", title: "地图导出",
    fileName: "地图导出-a-a4l.png",
  });
});

check("多图层组合展开且文件名含图层 id", () => {
  const plan = planExportJobs({
    projects: ["a"], layerSets: [[], ["highways", "stations"]], sizes: ["a4l"], formats: ["png"],
    title: "专项图集",
  });
  assert.equal(plan.jobs.length, 2);
  assert.equal(plan.jobs[1].fileName, "专项图集-a-highways_stations-a4l.png");
  assert.deepEqual(plan.jobs[1].layers, ["highways", "stations"]);
});

check("同输入去重（layerSets 重复 / sizes 重复）", () => {
  const plan = planExportJobs({
    projects: ["a"], layerSets: [["x"], ["x"]], sizes: ["a4l", "a4l"], formats: ["png", "png"],
  });
  assert.equal(plan.jobs.length, 1);
});

check("自定义尺寸被钳制到浏览器上限内", () => {
  const plan = planExportJobs({ projects: ["a"], sizes: [{ id: "custom", width: 99999, height: -5 }], formats: ["png"] });
  assert.equal(plan.errors.length, 0);
  const [job] = plan.jobs;
  assert.equal(job.width, CUSTOM_SIZE_LIMITS.width[1]);
  assert.equal(job.height, CUSTOM_SIZE_LIMITS.height[0]);
  assert.match(job.fileName, /2400x300\.png$/);
});

check("自定义尺寸缺数字 → 校验错误", () => {
  const plan = planExportJobs({ projects: ["a"], sizes: [{ id: "custom" }], formats: ["png"] });
  assert.ok(plan.errors.some((e) => e.includes("width/height")));
});

check("非法项目名 / 图层 id / 格式 / 空项目 → 校验错误且无任务", () => {
  assert.ok(planExportJobs({ projects: ["../evil"], formats: ["png"] }).errors.some((e) => e.includes("非法项目名")));
  assert.ok(planExportJobs({ projects: ["a"], layerSets: [["bad id!"]], formats: ["png"] }).errors.some((e) => e.includes("非法图层")));
  assert.ok(planExportJobs({ projects: ["a"], formats: ["svg"] }).errors.some((e) => e.includes("未知导出格式")));
  assert.ok(planExportJobs({ projects: [], formats: ["png"] }).errors.some((e) => e.includes("projects 不能为空")));
  const empty = planExportJobs({ projects: ["a"], formats: ["png"], sizes: ["nope"] });
  assert.ok(empty.errors.some((e) => e.includes("sizes 不能为空")));
  assert.equal(empty.jobs.length, 0);
});

check("字符串逗号列表与数组等价（前端直传宽容）", () => {
  const a = planExportJobs({ projects: "a,b", formats: "png,pdf" });
  const b = planExportJobs({ projects: ["a", "b"], formats: ["png", "pdf"] });
  assert.deepEqual(a.jobs.map((j) => `${j.project}.${j.format}`), b.jobs.map((j) => `${j.project}.${j.format}`));
});

check("超出 MAX_JOBS 截断且 skipped 可见", () => {
  const projects = Array.from({ length: 30 }, (_, i) => `p${i}`);
  const plan = planExportJobs({ projects, sizes: ["a4l"], formats: ["png"] });
  assert.equal(plan.jobs.length, MAX_JOBS);
  assert.equal(plan.skipped, 30 - MAX_JOBS);
  assert.ok(plan.jobs.every((j, i) => j.id === `job-${i + 1}`));
});

check("文件名清洗：项目/标题中的非法字符被替换", () => {
  const plan = planExportJobs({ projects: ["a"], formats: ["png"], title: "报<告>:图/集" });
  assert.ok(!/[<>:/\\*?"|]/.test(plan.jobs[0].fileName));
});

console.log("▶ runExportQueue 队列编排");
await (async () => {
  const jobs = planExportJobs({ projects: ["a", "b", "c"], sizes: ["a4l"], formats: ["png"] }).jobs;

  await new Promise((resolve) => {
    const runs = [];
    const progressSnapshots = [];
    runExportQueue(jobs, async (job) => {
      runs.push(job.id);
      if (job.project === "b") throw new Error("模拟失败");
      return { file: `out/${job.fileName}`, bytes: 123 };
    }, { onProgress: (s) => progressSnapshots.push({ ...s }) }).then((summary) => {
      check("串行执行且按入队顺序", () => assert.deepEqual(runs, ["job-1", "job-2", "job-3"]));
      check("成功/失败分别计数", () => {
        assert.equal(summary.done, 2);
        assert.equal(summary.failed, 1);
        assert.equal(summary.total, 3);
      });
      check("失败任务带原因、成功任务带产物路径", () => {
        const failed = summary.results.find((r) => r.status === "failed");
        assert.equal(failed.error, "模拟失败");
        const done = summary.results.filter((r) => r.status === "done");
        assert.ok(done.every((r) => r.file && r.ms >= 0));
      });
      check("进度回调覆盖 running 与终态", () => {
        // 每个任务两次快照（进入 running + 结束），最后快照 done=2 failed=1
        assert.equal(progressSnapshots.length, 6);
        assert.equal(progressSnapshots[0].done, 0);
        const last = progressSnapshots[progressSnapshots.length - 1];
        assert.equal(last.done, 2);
        assert.equal(last.failed, 1);
        assert.equal(last.total, 3);
      });
      check("时间戳成对出现", () => {
        assert.ok(summary.startedAt && summary.finishedAt && summary.finishedAt >= summary.startedAt);
      });
      resolve();
    });
  });

  await new Promise((resolve) => {
    runExportQueue([{ id: "job-1", project: "a", format: "png", sizeId: "a4l" }], null).then((summary) => {
      check("执行器缺失 → 任务失败而非崩溃", () => {
        assert.equal(summary.failed, 1);
        assert.match(summary.results[0].error, /执行器不可用/);
      });
      resolve();
    });
  });

  await new Promise((resolve) => {
    runExportQueue([], async () => ({})).then((summary) => {
      check("空队列 → 零任务汇总", () => {
        assert.equal(summary.total, 0);
        assert.equal(summary.done, 0);
        assert.equal(summary.failed, 0);
      });
      resolve();
    });
  });
})();

console.log(process.exitCode ? "批量导出回归：存在失败用例" : `批量导出回归：通过（${passed.length} 项）`);
