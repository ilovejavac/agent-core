import test from 'node:test';
import assert from 'node:assert/strict';
import {createEventSmoother} from "../src/buffer.ts";


test('加法函数计算正确', async () => {
    const smoother = createEventSmoother((chunk) => console.log(chunk));

    smoother.push("你");
    smoother.push("好");
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    smoother.push("，TypeScript 🙂");

    await smoother.end();
});

test('支持异步测试', async () => {

});
