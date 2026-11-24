.PHONY: start restart stop status copy-url logs restart-app

start:
	/bin/bash scripts/server-macos.sh start

restart:
	/bin/bash scripts/server-macos.sh restart

stop:
	/bin/bash scripts/server-macos.sh stop

status:
	/bin/bash scripts/server-macos.sh status

copy-url:
	/bin/bash scripts/server-macos.sh copy-url

logs:
	/bin/bash scripts/server-macos.sh logs

restart-app:
	/bin/bash scripts/restart-macos.sh
