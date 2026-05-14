// Wrapper around @changesets/changelog-github that drops the commit-hash link
// from each release line. We keep PR + author attribution and the linkified
// issue refs that the upstream generator produces.
//
// Upstream emits:
//   - [#67](.../pull/67) [`f707bf8`](.../commit/f707bf8...) Thanks [@user](...)! - summary
// We emit:
//   - [#67](.../pull/67) Thanks [@user](...)! - summary

const upstream = require("@changesets/changelog-github").default;

// Matches the inline `[\`<sha>\`](<commit-url>)` token immediately after the
// leading "- " (with optional leading PR link). Anchored to the start of the
// release line so we never strip a hash that happens to appear inside the
// changeset summary itself.
const COMMIT_LINK_AFTER_LEADER = /^(\n\n- (?:\[#\d+\]\([^)]+\) )?)\[`[^`]+`\]\([^)]+\) /;

module.exports = {
	getDependencyReleaseLine: upstream.getDependencyReleaseLine,
	getReleaseLine: async (changeset, type, options) => {
		const line = await upstream.getReleaseLine(changeset, type, options);
		return line.replace(COMMIT_LINK_AFTER_LEADER, "$1");
	},
};
