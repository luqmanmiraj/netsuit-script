/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 */
define([], function () {
  function pageInit(context) {
    alert('Hello from SuiteScript (Client Script)!');
  }
  return { pageInit: pageInit };
});
