import assert from "node:assert/strict";
import test from "node:test";
import { createSlashCommands, routeSkills, type SkillEntry } from "../apps/cli/src/interaction.ts";

const n8nNodeConfiguration: SkillEntry = {
	name: "n8n-node-configuration",
	path: "/user/n8n-node-configuration/SKILL.md",
	root: "/user",
	source: "user",
	description: "Operation-aware node configuration guidance. Use when configuring nodes, understanding property dependencies, determining required fields, choosing between get_node detail levels, or learning common configuration patterns by node type.",
};

const azureExporter: SkillEntry = {
	name: "azure-monitor-opentelemetry-exporter-java",
	path: "/user/azure-monitor-opentelemetry-exporter-java/SKILL.md",
	root: "/user",
	source: "user",
	description: "Azure Monitor OpenTelemetry Exporter for Java. Export OpenTelemetry traces, metrics, and logs to Azure Monitor/Application Insights.",
};

const comprehensiveReview: SkillEntry = {
	name: "comprehensive-review-full-review",
	path: "/user/comprehensive-review-full-review/SKILL.md",
	root: "/user",
	source: "user",
	description: "Perform a comprehensive code review and report correctness, security, and maintainability findings.",
};

const securityRequirements: SkillEntry = {
	name: "security-requirement-extraction",
	path: "/user/security-requirement-extraction/SKILL.md",
	root: "/user",
	source: "user",
	description: "Derive security requirements from threat models and business context. Use when translating threats into actionable requirements.",
};

test("implementation vocabulary does not auto-select an unrelated skill", () => {
	const unrelatedSkills: SkillEntry[] = [
		n8nNodeConfiguration,
		azureExporter,
		comprehensiveReview,
		securityRequirements,
		{
			name: "conductor-implement",
			path: "/user/conductor-implement/SKILL.md",
			root: "/user",
			source: "user",
			description: "Execute tasks from a track's implementation plan following TDD workflow.",
		},
		{
			name: "spreadsheet-agent",
			path: "/user/spreadsheet-agent/SKILL.md",
			root: "/user",
			source: "user",
			description: "Create formulas and validate spreadsheet workbooks.",
		},
	];
	assert.deepEqual(
		routeSkills("Implement pricing with node:test for value and type tests in package scripts", unrelatedSkills),
		[],
	);
	assert.deepEqual(
		routeSkills("Implement and export applyDiscount, validate percent and fixed inputs, then run npm test", unrelatedSkills),
		[],
	);
});

test("an explicit n8n node request still selects node configuration", () => {
	assert.deepEqual(
		routeSkills("Configure an n8n node for a Slack resource and operation", [n8nNodeConfiguration]),
		["n8n-node-configuration"],
	);
	assert.deepEqual(routeSkills("Configure a node for a Slack resource and operation", [n8nNodeConfiguration]), []);
});

test("permissions slash command completes the available modes", () => {
	const permissions = createSlashCommands([]).find(({ name }) => name === "permissions");
	assert.equal(permissions?.argumentHint, "<ask|auto|full-access>");
	assert.deepEqual(permissions?.getArgumentCompletions?.(""), [
		{ value: "ask", label: "ask" },
		{ value: "auto", label: "auto" },
		{ value: "full-access", label: "full-access" },
	]);
	assert.deepEqual(permissions?.getArgumentCompletions?.("full"), [{ value: "full-access", label: "full-access" }]);
});
