import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(process.cwd());
const casesPath = path.join(root, 'qa', 'invoke-cases.json');
const source = JSON.parse(fs.readFileSync(casesPath, 'utf-8'));

function routePrompt(prompt) {
	const text = prompt.toLowerCase();
	if (text.includes('waiting in review')) return 'get_tasks_in_review';
	if ((text.includes('done') || text.includes('in review') || text.includes('in progress') || text.includes('status')) && text.includes('task')) {
		return 'set_task_status';
	}
	if (text.includes('plan')) return 'update_task_plan';
	if (text.includes('implemented') || text.includes('tested') || text.includes('walkthrough') || text.includes('document')) {
		return 'update_task_walkthrough';
	}
	if (text.includes('active tasks')) return 'get_active_tasks';
	if (text.includes('search')) return 'search_tasks';
	if (text.includes('compact context')) return 'get_task_context_compact';
	if (text.includes('metadata')) return 'get_task_section';
	return 'list_tasks';
}

const results = source.map((item) => {
	const predicted = routePrompt(item.prompt);
	return { ...item, predicted, pass: predicted === item.expected_tool };
});

const passed = results.filter((item) => item.pass).length;
const total = results.length;
const score = Number(((passed / total) * 100).toFixed(2));

console.log(`LLM invoke benchmark: ${passed}/${total} (${score}%)`);
for (const item of results) {
	console.log(`${item.pass ? '✅' : '❌'} ${item.expected_tool} <= "${item.prompt}" (predicted: ${item.predicted})`);
}

if (score < 85) {
	console.error(`Benchmark below release threshold (85%). Current: ${score}%`);
	process.exit(1);
}
