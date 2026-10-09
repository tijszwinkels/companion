// Limits for one recent or historical DISPLAY PAGE, never for persisted history
// or admitting a model turn. Older rows/text remain accessible by paging.
export const panelMessageLimit = 200;

// JavaScript UTF-16 units of text + input. Tools carry only body-free summaries;
// giant ordinary messages span labelled fragments on successive pages.
export const panelTextLimit = 64 * 1024;
