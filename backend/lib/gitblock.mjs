// Markers of the managed local-only block in a project's .gitignore.
export const GI_START = '# >>> circle-studio: local-only >>>';
export const GI_END = '# <<< circle-studio: local-only <<<';

export const gitignoreBlockPresent = (text) => text.includes(GI_START) && text.includes(GI_END);
