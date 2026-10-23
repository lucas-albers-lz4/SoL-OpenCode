Fix the off-by-one bug in `sum.sh` so every positional argument is included in the sum.

Use the host `edit` tool to change only the loop boundary in `sum.sh`; do not use shell redirection or a whole-file write.

Pass `then_run` on the edit call as the object `{ "command": "sh test_sum.sh" }`. Do not pass it as a string. Do not run the test in a separate shell call.

Do not change `test_sum.sh`. In your final response, state the test result and whether you used `then_run`.
