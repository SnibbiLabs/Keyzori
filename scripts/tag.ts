const tag = Bun.argv[2];

if (!tag || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
	throw new Error("Usage: bun scripts/tag.ts v<major>.<minor>.<patch>");
}

await Bun.$`git fetch origin main`
await Bun.$`git tag --force --annotate ${tag} origin/main --message ${tag}`
await Bun.$`git push origin refs/tags/${tag}`

console.log(`Tag created: ${tag}`);
