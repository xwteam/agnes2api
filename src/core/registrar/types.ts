/** 一个临时邮箱。`handle` 供 provider 内部定位（YYDS 用地址、MoeMail 用 id）。 */
export interface Mailbox {
  address: string;
  handle: string;
}
