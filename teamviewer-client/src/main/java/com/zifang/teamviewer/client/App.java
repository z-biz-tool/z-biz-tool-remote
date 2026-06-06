package com.zifang.teamviewer.client;

import java.util.Scanner;

public class App {

    public static void main(String[] args) {
        NettyClient nettyClient = new NettyClient(); // 连接的终端
        NettyClientExecutor nettyClientExecutor = new NettyClientExecutor(nettyClient); //持有连接的终端

        nettyClientExecutor.printOriginalHint();
        Scanner in=new Scanner(System.in);
        while (in.hasNext()){
            String command = in.nextLine();// 从命令行得到的命令
            String hint = nettyClientExecutor.exec(command);// 执行指令并提示下个指令
            System.out.println(hint);
        }
    }
}
