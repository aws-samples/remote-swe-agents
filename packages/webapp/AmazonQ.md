## How to add Server Action
* webapp/src/actions/schemas に入力のZodスキーマを定義する
    * これはクライアント側とサーバー側双方で共有される
* webapp/src/actionsに Server Actionを定義する
    * `import { authActionClient } from '@/lib/safe-action';` を使うことで、必ず認証をかけること
    * 

## 重要: PRに関する注意事項
* リポジトリの変更を行う場合は、**必ずフォーク元のリポジトリ (aws-samples/remote-swe-agents)** に対してプルリクエストを作成すること
* フォークしたリポジトリ自体に対してPRを出さないよう注意
