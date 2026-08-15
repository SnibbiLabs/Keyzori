const tag = Bun.argv[2];

await Bun.$`git checkout main`.quiet(true);
await Bun.$`git tag -d ${tag}`.quiet(true);
await Bun.$`git tag -a ${tag} main -m \"${tag}\"`.quiet(true);
await Bun.$`git push ref/tags/${tag}`.quiet(true);

console.log(`Tag created: ${tag}`);
