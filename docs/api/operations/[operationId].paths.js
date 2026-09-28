import { existsSync, readFileSync } from 'node:fs';
import { usePaths } from 'vitepress-openapi';
import spec from '../../.vitepress/data/openapi.json' with { type: 'json' };

export default {
    paths() {
        const operations = usePaths({ spec }).getPathsByVerbs();
        const summaryCounts = new Map();

        operations.forEach(({ summary }) => summaryCounts.set(summary, (summaryCounts.get(summary) || 0) + 1));

        return operations.map(({ operationId, path, verb, summary }) => {
            const disambiguator = summaryCounts.get(summary) > 1 ? ` (${verb.toUpperCase()} ${path})` : '';

            const guide = new URL(`../usage/${operationId}.md`, import.meta.url);

            return {
                content: existsSync(guide) ? readFileSync(guide, 'utf8') : '',
                params: {
                    operationId,
                    pageTitle: `${summary}${disambiguator} | TypeRelay API`,
                    pageDescription: `TypeRelay API reference for ${summary.toLowerCase()} with the ${verb.toUpperCase()} ${path} endpoint, including request and response details.`,
                },
            };
        });
    },
};
