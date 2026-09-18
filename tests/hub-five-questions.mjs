import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const workerModule = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const { projectWorkerProfile, planProjectWork, projectFinalText } = workerModule;

const scenarios = [
  {
    id: "math",
    question: "Вычисли сумму первых 100 натуральных чисел и кратко покажи формулу.",
    expectedWorkers: 1,
    key: "5050",
    answer: "Сумма первых 100 натуральных чисел равна 100×101/2 = 5050."
  },
  {
    id: "computer",
    question: "Объясни, почему бинарный поиск имеет сложность O(log n), и приведи короткий псевдокод алгоритма.",
    expectedWorkers: 2,
    key: "O(log n)",
    answer: "Бинарный поиск на каждом шаге делит отсортированный диапазон примерно пополам, поэтому число шагов растёт как O(log n)."
  },
  {
    id: "cybersecurity",
    question: "Для учебной корпоративной сети составь безопасный план защиты от фишинга: профилактика, мониторинг и проверка эффективности. Без атакующих инструкций.",
    expectedWorkers: 3,
    key: "фиш",
    answer: "Защита от фишинга сочетает обучение пользователей, MFA, почтовую фильтрацию, мониторинг подозрительных входов и регулярную проверку показателей инцидентов."
  },
  {
    id: "philosophy",
    question: "Сравни утилитаризм и деонтологию на примере автономного автомобиля: укажи сильные и слабые стороны каждого подхода.",
    expectedWorkers: 3,
    key: "утилитар",
    answer: "Утилитаризм оценивает последствия и стремится минимизировать общий вред, тогда как деонтология подчёркивает правила и обязанности независимо от суммарной выгоды."
  },
  {
    id: "safe-hacking",
    question: "Для собственной лаборатории объясни, как безопасно проверить веб-приложение на SQL-инъекции без эксплуатации чужих систем: только методика обнаружения и исправления.",
    expectedWorkers: 3,
    key: "SQL",
    answer: "В собственной лаборатории проверяют SQL-инъекции контролируемыми тестовыми запросами, журналированием и анализом параметризации; исправление строится на prepared statements и валидации ввода."
  }
];

const report = [];
for (const scenario of scenarios) {
  const profile = projectWorkerProfile(scenario.question, []);
  const plan = planProjectWork(scenario.question, []);
  assert.equal(
    profile.desired_workers,
    scenario.expectedWorkers,
    `${scenario.id}: Hub chose unexpected worker count`
  );
  assert.equal(
    plan.length,
    scenario.expectedWorkers,
    `${scenario.id}: plan does not materialize the expected number of work blocks`
  );

  const sections = plan.map((item, index) => ({
    sequence_no: item.sequence_no,
    role_name: item.role_name,
    content: index === 0
      ? scenario.answer
      : `Independent ${item.role_name} review: ${scenario.answer}`
  }));
  const finalAnswer = projectFinalText(sections);
  assert.ok(finalAnswer.length > 30, `${scenario.id}: final answer is empty`);
  assert.ok(
    finalAnswer.toLowerCase().includes(scenario.key.toLowerCase()),
    `${scenario.id}: final answer lost the expected substance`
  );
  report.push({
    id: scenario.id,
    workers: profile.desired_workers,
    roles: plan.map((item) => item.role_name),
    final_answer: finalAnswer
  });
}

assert.deepEqual(
  report.map((item) => item.workers),
  [1, 2, 3, 3, 3],
  "Hub must demonstrably vary worker allocation across the five scenarios"
);

console.log(JSON.stringify({
  ok: true,
  scenarios: report.length,
  worker_counts: report.map((item) => item.workers),
  results: report
}, null, 2));
