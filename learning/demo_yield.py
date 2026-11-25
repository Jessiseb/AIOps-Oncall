"""yield 演示：亲眼看到函数的"冻结-解冻"。

运行：python learning/demo_yield.py
对照着想：aiops_service.execute() 就是这个模式（app/services/aiops_service.py:81）。
"""

def execute():
    print("    [函数] 1. 制定计划")
    yield "plan: [查监控, 查日志]"

    print("    [函数] 2. 查监控完成")
    yield "step: 查监控"

    print("    [函数] 3. 查日志完成")
    yield "step: 查日志"

    print("    [函数] 4. 生成报告")
    yield "complete: 报告"


print("== 第一步：只调用 execute()，看下面有没有打印'制定计划' ==")
gen = execute()
print("== 拿到的只是个遥控器：", gen)
print("== 结论：函数体一行都没跑 ==\n")

print("== 第二步：for 循环每要一个值，函数才跑一段 ==\n")
for event in gen:
    print(f"    [消费方] 收到事件 -> {event}")
    print("    ---- 函数此刻又冻结了 ----\n")

print("== 取尽，for 循环退出 ==")
