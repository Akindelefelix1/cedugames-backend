import xss, { type IFilterXSSOptions } from "xss";

const richTextOptions: IFilterXSSOptions = {
  whiteList: {
    p: ["style"],
    br: [],
    strong: [],
    b: [],
    em: [],
    i: [],
    u: [],
    s: [],
    ul: [],
    ol: [],
    li: [],
    div: ["style"],
  },
  css: { whiteList: { "text-align": /^(left|center|right)$/ } },
  stripIgnoreTag: true,
  stripIgnoreTagBody: ["script", "style"],
};

const plainTextOptions: IFilterXSSOptions = {
  whiteList: {},
  stripIgnoreTag: true,
  stripIgnoreTagBody: ["script", "style"],
};

export const cleanRichText = (value: string): string => xss(value, richTextOptions);

export const plainText = (value: string): string =>
  xss(value, plainTextOptions).replace(/&nbsp;/gi, " ").trim();
