import DefaultTheme from 'vitepress/theme';
import { theme, useOpenapi, useTheme } from 'vitepress-openapi/client';
import { enhanceAppWithTabs } from 'vitepress-plugin-tabs/client';
import 'vitepress-openapi/dist/style.css';
import './custom.css';
import spec from '../data/openapi.json' with { type: 'json' };

export default {
    extends: DefaultTheme,
    enhanceApp({ app }) {
        useOpenapi({ spec });
        // vitepress-openapi renders operation descriptions with markdown-it
        // `breaks: true`, so every single newline in a description becomes a
        // <br>, breaking wrapped sentences onto their own lines. Turn it off so
        // single newlines collapse to spaces (CommonMark soft break) and text
        // flows as paragraphs; blank lines still separate paragraphs.
        useTheme({
            markdown: {
                config: (md) => {
                    md.set({ breaks: false });
                    return md;
                },
            },
        });
        theme.enhanceApp({ app });
        enhanceAppWithTabs(app);
    },
};
