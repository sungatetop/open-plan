/**
 * shpjs 类型声明（F5-5）：client 侧为 JS 无类型面，桌面端 strict 下按实际用法
 * （默认导出可调用 + parseShp/parseDbf/combine 静态方法）给 any 收口，不改运行时语义。
 */
declare module "shpjs" {
  const shp: any;
  export default shp;
}
