// 测试引导：在任何 TS 模块加载前注入 fake-indexeddb 全局
const fake = require('fake-indexeddb');
globalThis.indexedDB = fake.indexedDB;
globalThis.IDBKeyRange = fake.IDBKeyRange;
