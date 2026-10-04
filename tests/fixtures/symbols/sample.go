package main

import "fmt"

type Server struct {
	Name string
}

// Start starts the server.
func (s *Server) Start() error {
	fmt.Println("}")
	return nil
}

func main() {
	s := Server{}
	_ = s.Start()
}
